export function buildArgsWithOptionalOptions(primary?: any): any[] {
    return primary !== undefined ? [primary] : [];
}
