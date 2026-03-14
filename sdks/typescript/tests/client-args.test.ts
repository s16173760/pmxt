import { buildArgsWithOptionalOptions } from "../pmxt/args.js";

describe("buildArgsWithOptionalOptions", () => {
    test("returns empty array when primary is undefined", () => {
        expect(buildArgsWithOptionalOptions(undefined)).toEqual([]);
    });

    test("returns empty array when called with no arguments", () => {
        expect(buildArgsWithOptionalOptions()).toEqual([]);
    });

    test("wraps a defined primary value in an array", () => {
        expect(buildArgsWithOptionalOptions({ limit: 10 })).toEqual([{ limit: 10 }]);
    });

    test("treats null as a defined value", () => {
        expect(buildArgsWithOptionalOptions(null)).toEqual([null]);
    });

    test("treats 0 as a defined value", () => {
        expect(buildArgsWithOptionalOptions(0)).toEqual([0]);
    });

    test("treats empty string as a defined value", () => {
        expect(buildArgsWithOptionalOptions("")).toEqual([""]);
    });
});
