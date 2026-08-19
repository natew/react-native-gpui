// Shared hermesc flags for every bundle we compile against the source-built
// Hermes in ~/github/hermes (branch `static_h`).
//
// `-Xes6-block-scoping` is NOT optional. That build has it OFF by default and
// hides it behind -Xhelp-hidden, and without it `let` compiles with FUNCTION
// scoping: one binding shared by the whole loop instead of a fresh binding per
// iteration. Every closure created in a loop then reads the final value.
//
//   for (let v of ['x','y','z']) out.push(() => v)   // -> z,z,z
//
// It breaks classic `for`, `for-of`, and `for-in` alike, so it is a silent,
// whole-program JS semantics break rather than an edge case. It reliably
// destroys the CJS/ESM interop namespace every bundler emits:
//
//   for (let key of __getOwnPropNames(mod))
//     __defProp(to, key, { get: () => mod[key] })
//
// Every getter ends up reading the module's LAST property, so `React.createContext`
// returned the string "19.2.6" (React's `version`, its final export) and the app
// died at startup with "'19.2.6' is not a function". The same bug is the likelier
// explanation for the "undefined is not a function" boot crash previously blamed
// on a miscompiling npm hermesc in gui/native-shell/scripts/bundle-app-hermes.mjs.
//
// Verified 2026-08-19: without the flag `for (let ...)` closure capture returns the
// last value in all three loop forms; with it, all three are correct.
export const hermescArgs = ['-emit-binary', '-O', '-Xes6-block-scoping']
