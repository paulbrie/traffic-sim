// Component tests' setup (vitest.config.ts): each test's render taken down after it, and what jsdom lacks that the UI's
// components (Radix) ask for.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// (Radix measures with ResizeObserver, and its sliders and selects capture the pointer)
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
for (const k of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) (Element.prototype as unknown as Record<string, unknown>)[k] ??= () => false;
Element.prototype.scrollIntoView ??= () => {};
