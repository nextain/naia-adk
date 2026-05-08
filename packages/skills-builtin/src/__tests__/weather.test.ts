import { describe, expect, it } from "vitest";
import { weatherDescriptor } from "../index.js";

describe("weatherDescriptor", () => {
	it("exports a SkillDescriptor", () => {
		expect(weatherDescriptor).toBeDefined();
	});

	it("has correct name", () => {
		expect(weatherDescriptor.name).toBe("weather");
	});

	it("has correct tier", () => {
		expect(weatherDescriptor.tier).toBe("T0");
	});

	it("has required location in inputSchema", () => {
		const schema = weatherDescriptor.inputSchema as {
			required?: string[];
			properties?: Record<string, unknown>;
		};
		expect(schema.required).toContain("location");
		expect(schema.properties).toHaveProperty("location");
	});

	it("has description", () => {
		expect(typeof weatherDescriptor.description).toBe("string");
		expect(weatherDescriptor.description.length).toBeGreaterThan(0);
	});

	it("has version", () => {
		expect(typeof weatherDescriptor.version).toBe("string");
		expect(weatherDescriptor.version).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
