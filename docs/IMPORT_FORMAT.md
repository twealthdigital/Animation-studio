# HTML & 3D Character Import Format & Stagecraft Character SDK

Stagecraft 3D imports characters via an extensible adapter contract (`ICharacterAdapter`), supporting standalone `.html` Three.js character packages and `.glb` / `.gltf` 3D models.

## 1. Supported Import Modes
1. **Mode A — Native Three.js Extraction (`native-three-extraction`)**
   - Used when an `.html` file initializes a Three.js `Scene` / `Group` / `Mesh` hierarchy and animation loop.
   - Extracts the character root directly into the Studio master WebGL scene with full 3D transforms, snapping, curve motion paths, child node/body-part selection, IK overlays, facial blend overrides, shadows, and lighting.
   - Semantic node auto-discovery labels both explicit `.name` bones/groups and unnamed procedural limb hierarchies (`Head`, `UpperArm`, `Forearm`, `Hand`, `Thigh`, `Shin`) and applies user bone/IK overrides **after** the character's internal frame tick so user animation is never overwritten.
2. **Mode B — Isolated HTML Sandbox (`isolated-iframe`)**
   - Used when an HTML character relies on non-Three.js DOM/Canvas/custom runtimes or external scripts that cannot be safely extracted.
   - Renders inside a sandboxed `<iframe sandbox="allow-scripts">` coupled with a spatial studio locator proxy and a structured `postMessage` bridge.
   - Explicit limitation: arbitrary DOM/CSS scenes cannot be merged directly into WebGL lighting or per-bone IK.
3. **GLB / GLTF (`gltf-native`)**
   - Supports skeletal `SkinnedMesh` rigs, embedded `AnimationClip`s, morph target dictionaries (`morphTargetInfluences`), and automatic humanoid bone mapping.

## 2. Stagecraft Character SDK (`window.STAGECRAFT_SDK` / Metadata Contract)
Authors creating HTML characters for maximum studio compatibility can expose either a standard API object on `window` or the explicit SDK descriptor:

```js
window.STAGECRAFT_SDK = {
  version: '1.0',
  name: 'Character Name',
  rootGroup: characterGroup,        // Optional explicit THREE.Group reference
  stageProps: [floorMesh, bgMesh],  // Optional array of backdrop objects to toggle
  nodes: {                          // Optional explicit semantic rig mapping
    head: headPivot,
    leftUpperArm: armL.sh,
    leftForearm: armL.el,
    leftHand: armL.hand,
    rightUpperArm: armR.sh,
    rightForearm: armR.el,
    rightHand: armR.hand,
    leftThigh: legL.hip,
    leftShin: legL.knee,
    rightThigh: legR.hip,
    rightShin: legR.knee,
  },
  moods: ['neutral', 'happy', 'surprised', 'angry', 'sad'],
  actions: ['nod', 'shake', 'wave', 'walk', 'point'],
  setMood(name) { /* ... */ },
  talk(active, level) { /* active: boolean, optional amplitude 0..1 */ },
  setExpression(facialState) { /* optional { smile, browRaise, mouthOpen, blink, ... } */ },
  playAction(id, opts) { /* ... */ },
};
```

## 3. Mode B `postMessage` Bridge
```ts
// Studio -> Character Iframe
{ type: 'studio:command', command: 'playAction' | 'setMood' | 'talk' | 'pause' | 'resume' | 'reset', payload?: unknown }
// Character Iframe -> Studio
{ type: 'studio:ready', capabilities: { actions: string[], moods: string[] } }
```
