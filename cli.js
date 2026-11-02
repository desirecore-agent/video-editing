#!/usr/bin/env node
"use strict";
// Preserve the fablecut binary name while using the same formal lifecycle and generation checks.
import("./desirecore/cli.mjs").then(({main})=>main(process.argv.slice(2))).catch(e=>{console.error(e.message);process.exitCode=1;});
