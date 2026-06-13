#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { effectBackgroundImage, smokeEffectBackgroundImage } from "../src/surfaces.tsx";

assert.equal(
    smokeEffectBackgroundImage({ alpha: 0.5, reach: 0.25, topClear: 0.75 }),
    "smoke(rgba(0,0,0,0.5) 25%, rgba(0,0,0,0) 75%)",
);

assert.equal(
    smokeEffectBackgroundImage({ color: "#111111", fadedColor: "rgba(0,0,0,0)", reach: 0.3333 }),
    "smoke(#111111 33.33%, rgba(0,0,0,0) 34%)",
);

assert.equal(
    effectBackgroundImage({ type: "backgroundImage", backgroundImage: "linear-gradient(red, blue)" }),
    "linear-gradient(red, blue)",
);

console.log("SURFACES_UNIT_PASS effect-background-image=stable");
