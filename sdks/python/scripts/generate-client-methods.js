'use strict';

/**
 * Generates the simple pass-through methods in pmxt/client.py from BaseExchange.ts.
 *
 * Every public method in BaseExchange.ts that is not in SKIP_GENERATE is templated
 * as a POST call to the sidecar and injected between the generation markers in
 * client.py. This ensures the Python SDK surface stays in sync with the core.
 *
 * Run: node sdks/python/scripts/generate-client-methods.js
 */

const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const BASE_EXCHANGE_PATH = path.join(__dirname, '../../../core/src/BaseExchange.ts');
const CLIENT_PATH = path.join(__dirname, '../pmxt/client.py');

const MARKER_BEGIN = '    # BEGIN GENERATED METHODS';
const MARKER_END = '    # END GENERATED METHODS';

// Methods kept hand-maintained in client.py (special logic, streaming, local-only)
const SKIP_GENERATE = new Set([
    'callApi',
    'defineImplicitApi',
    'loadMarkets',               // Python-level caching
    'fetchOHLCV',                // datetime→ISO conversion
    'fetchTrades',               // special parameter handling
    'watchOrderBook',            // streaming
    'watchTrades',               // streaming
    'createOrder',               // outcome shorthand logic
    'buildOrder',                // complex args format
    'submitOrder',               // complex args format
    'getExecutionPrice',         // delegates to getExecutionPriceDetailed
    'getExecutionPriceDetailed', // complex args format
    'filterMarkets',             // pure local computation, no sidecar
    'filterEvents',              // pure local computation, no sidecar
]);

// Return type config for each generated method.
// returnPy: Python return type annotation
// pattern:  how to handle response data
// converter: converter function name (for array/single patterns)
const METHOD_RETURN_CONFIG = {
    fetchMarkets: { returnPy: 'List[UnifiedMarket]', pattern: 'array', converter: '_convert_market' },
    fetchMarketsPaginated: { returnPy: 'PaginatedMarketsResult', pattern: 'paginated' },
    fetchEvents: { returnPy: 'List[UnifiedEvent]', pattern: 'array', converter: '_convert_event' },
    fetchMarket: { returnPy: 'UnifiedMarket', pattern: 'single', converter: '_convert_market' },
    fetchEvent: { returnPy: 'UnifiedEvent', pattern: 'single', converter: '_convert_event' },
    fetchOrderBook: { returnPy: 'OrderBook', pattern: 'single', converter: '_convert_order_book' },
    cancelOrder: { returnPy: 'Order', pattern: 'single', converter: '_convert_order' },
    fetchOrder: { returnPy: 'Order', pattern: 'single', converter: '_convert_order' },
    fetchOpenOrders: { returnPy: 'List[Order]', pattern: 'array', converter: '_convert_order' },
    fetchMyTrades: { returnPy: 'List[UserTrade]', pattern: 'array', converter: '_convert_user_trade' },
    fetchClosedOrders: { returnPy: 'List[Order]', pattern: 'array', converter: '_convert_order' },
    fetchAllOrders: { returnPy: 'List[Order]', pattern: 'array', converter: '_convert_order' },
    fetchPositions: { returnPy: 'List[Position]', pattern: 'array', converter: '_convert_position' },
    fetchBalance: { returnPy: 'List[Balance]', pattern: 'array', converter: '_convert_balance' },
    close: { returnPy: 'None', pattern: 'void' },
};

// ---------------------------------------------------------------------------
// TypeScript AST helpers
// ---------------------------------------------------------------------------

function camelToSnake(s) {
    return s.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
}

function typeNodeToPy(node, sf) {
    if (!node) return 'Any';
    switch (node.kind) {
        case ts.SyntaxKind.StringKeyword: return 'str';
        case ts.SyntaxKind.NumberKeyword: return 'float';
        case ts.SyntaxKind.BooleanKeyword: return 'bool';
        case ts.SyntaxKind.VoidKeyword: return 'None';
        case ts.SyntaxKind.AnyKeyword: return 'Any';
        case ts.SyntaxKind.UndefinedKeyword: return 'Any';
        case ts.SyntaxKind.TypeLiteral: return 'dict';
        case ts.SyntaxKind.TypeReference: {
            const name = node.typeName.kind === ts.SyntaxKind.Identifier
                ? node.typeName.text
                : node.typeName.right.text;
            if (name === 'Promise' && node.typeArguments) {
                return typeNodeToPy(node.typeArguments[0], sf);
            }
            if (name === 'string') return 'str';
            if (name === 'number') return 'float';
            if (name === 'boolean') return 'bool';
            return 'dict';
        }
        case ts.SyntaxKind.UnionType: {
            const nonNull = node.types.filter(t =>
                t.kind !== ts.SyntaxKind.UndefinedKeyword &&
                t.kind !== ts.SyntaxKind.NullKeyword
            );
            if (nonNull.length === 1) return typeNodeToPy(nonNull[0], sf);
            return 'Any';
        }
        default: return 'dict';
    }
}

function isPublicMethod(node) {
    if (!node.modifiers) return true;
    for (const mod of node.modifiers) {
        if (
            mod.kind === ts.SyntaxKind.PrivateKeyword ||
            mod.kind === ts.SyntaxKind.ProtectedKeyword ||
            mod.kind === ts.SyntaxKind.AbstractKeyword
        ) return false;
    }
    return true;
}

function extractMethods(sourceFile) {
    const methods = [];

    function visitClass(classNode) {
        for (const member of classNode.members) {
            if (member.kind !== ts.SyntaxKind.MethodDeclaration) continue;
            if (!isPublicMethod(member)) continue;
            const name = member.name && member.name.kind === ts.SyntaxKind.Identifier
                ? member.name.text
                : null;
            if (!name) continue;
            if (SKIP_GENERATE.has(name)) continue;
            if (!METHOD_RETURN_CONFIG[name]) {
                console.warn(`  WARNING: no return config for public method '${name}', skipping`);
                continue;
            }
            methods.push(member);
        }
    }

    function visit(node) {
        if (node.kind === ts.SyntaxKind.ClassDeclaration) {
            visitClass(node);
            return;
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return methods;
}

// ---------------------------------------------------------------------------
// Code generation helpers
// ---------------------------------------------------------------------------

function buildPySignatureParams(params, sf) {
    return params.map(p => {
        const tsName = p.name.getText(sf);
        const snakeName = camelToSnake(tsName);
        const isOptional = !!p.questionToken;
        const typeStr = p.type ? typeNodeToPy(p.type, sf) : 'Any';
        if (isOptional) return `${snakeName}: Optional[${typeStr}] = None`;
        return `${snakeName}: ${typeStr}`;
    }).join(', ');
}

function buildPyArgsLines(params, sf) {
    const lines = [];
    for (const p of params) {
        const tsName = p.name.getText(sf);
        const snakeName = camelToSnake(tsName);
        if (p.questionToken) {
            lines.push(`            if ${snakeName} is not None:`);
            lines.push(`                args.append(${snakeName})`);
        } else {
            lines.push(`            args.append(${snakeName})`);
        }
    }
    return lines.join('\n');
}

function buildPyReturnLines(config) {
    const { pattern, converter } = config;
    const i = '            ';
    switch (pattern) {
        case 'array':
            return (
                `${i}data = self._handle_response(json.loads(response.data))\n` +
                `${i}return [${converter}(e) for e in data]`
            );
        case 'single':
            return (
                `${i}data = self._handle_response(json.loads(response.data))\n` +
                `${i}return ${converter}(data)`
            );
        case 'paginated':
            return [
                `${i}data = self._handle_response(json.loads(response.data))`,
                `${i}return PaginatedMarketsResult(`,
                `${i}    data=[_convert_market(m) for m in data.get("data", [])],`,
                `${i}    total=data.get("total", 0),`,
                `${i}    next_cursor=data.get("nextCursor"),`,
                `${i})`,
            ].join('\n');
        case 'void':
            return `${i}self._handle_response(json.loads(response.data))`;
        default:
            return `${i}data = self._handle_response(json.loads(response.data))\n${i}return data`;
    }
}

function generatePyMethod(name, params, config, sf) {
    const snakeName = camelToSnake(name);
    const paramSig = buildPySignatureParams(params, sf);
    const selfSig = paramSig ? `, ${paramSig}` : '';
    const { returnPy } = config;
    const argsLines = buildPyArgsLines(params, sf);
    const argsBlock = argsLines ? `\n${argsLines}` : '';
    const returnLines = buildPyReturnLines(config);

    return [
        `    def ${snakeName}(self${selfSig}) -> ${returnPy}:`,
        `        try:`,
        `            args = []${argsBlock}`,
        `            body: dict = {"args": args}`,
        `            creds = self._get_credentials_dict()`,
        `            if creds:`,
        `                body["credentials"] = creds`,
        `            url = f"{self._api_client.configuration.host}/api/{self.exchange_name}/${name}"`,
        `            headers = {"Content-Type": "application/json", "Accept": "application/json"}`,
        `            headers.update(self._get_auth_headers())`,
        `            response = self._api_client.call_api(method="POST", url=url, body=body, header_params=headers)`,
        `            response.read()`,
        returnLines,
        `        except Exception as e:`,
        `            raise Exception(f"Failed to ${snakeName}: {self._extract_api_error(e)}") from None`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const source = fs.readFileSync(BASE_EXCHANGE_PATH, 'utf-8');
    const sf = ts.createSourceFile('BaseExchange.ts', source, ts.ScriptTarget.ES2022, true);

    const methods = extractMethods(sf);

    const generated = methods.map(m => {
        const name = m.name.text;
        const config = METHOD_RETURN_CONFIG[name];
        return generatePyMethod(name, m.parameters, config, sf);
    }).join('\n\n');

    let client = fs.readFileSync(CLIENT_PATH, 'utf-8');

    const beginIdx = client.indexOf(MARKER_BEGIN);
    const endIdx = client.indexOf(MARKER_END);

    if (beginIdx === -1 || endIdx === -1) {
        throw new Error(
            `Generation markers not found in ${CLIENT_PATH}.\n` +
            `Add:\n  ${MARKER_BEGIN}\n  ${MARKER_END}`
        );
    }

    const before = client.slice(0, beginIdx + MARKER_BEGIN.length);
    const after = client.slice(endIdx);

    client = `${before}\n\n${generated}\n\n${after}`;

    fs.writeFileSync(CLIENT_PATH, client, 'utf-8');

    console.log(`Generated ${methods.length} methods in client.py:`);
    for (const m of methods) {
        console.log(`  + ${m.name.text}`);
    }
}

main();
