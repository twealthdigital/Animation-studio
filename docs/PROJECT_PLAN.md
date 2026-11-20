# Stagecraft 3D — Project Plan (Audited & Extended Production Roadmap)

Stagecraft 3D Studio is an interactive 3D animation & cartoon production environment built with React, TypeScript, and Three.js.

## Completed Foundation (Stages 0–15)
- Studio layout, panel splitters, theme, and dialogs
- Three.js WebGLRenderer with Editor Camera, Scene Camera, and software-WebGL pacing
- Mode A (Native Three.js HTML extraction), Mode B (Isolated HTML sandbox), and GLB/GLTF character loading
- Keyframe interpolation, basic cubic Bezier motion paths, timeline scrubbing, Web Audio mixing, IndexedDB persistence, and MediaRecorder export

## Active Production Phases (Parts 1–18 Upgrade Roadmap)
1. **Audit & Baseline**: Codebase audit, gap analysis, baseline tests (`node:test`) passing.
2. **Advanced 3D Manipulation & Selection**: Local/World gizmo space, precision grid/angle/scale snapping, axis constraints, pivot/origin offset, multi-object selection, group transforms, align & distribute, selection filters, selectable props/lights/cameras/body-parts/IK handles.
3. **Curve-Based Motion Paths**: Cubic Bezier, Quadratic Bezier, Catmull-Rom splines; open/closed paths; smooth/sharp corners; handle editing; scrub-along-path; reverse path; banking/tilt; look-at targets; independent paths on characters, props, and cameras.
4. **Character Hierarchy, Individual Bones & Rigging**: Live `Object3D`/Bone hierarchy inspector, auto humanoid bone mapping + manual override + missing-bone report, per-node rotation/translation keyframes, joint limits, visible viewport joint/bone overlay.
5. **IK/FK & Posing**: 2-bone analytic + FABRIK/CCD IK solver for arms, legs, and head look-at; draggable 3D IK targets; IK/FK weight blending; pose save, copy, mirror, and blend.
6. **Unified Animation Model, Visual Timeline & Graph Editor**: Expandable per-node/per-property tracks, Auto-Key, Step & Cubic Bezier tangents, multi-keyframe select/copy/paste/shift/stretch/reverse, frame step/speed/loop/work-area/lock/hide, and interactive Animation Graph Editor connected to `SceneEvaluator`.
7. **Smart Animation Assistant & Motion Presets**: Rig-mapped procedural presets (walk, run, jump, sit, wave, dance, talk, laugh, cry, point, clap, surprised), motion blending, beginner 1–7 action wizard, contextual suggestions engine + explicit external AI provider hook.
8. **Facial Animation**: Blend shapes/morph targets + facial bone + procedural fallback controls (blink, eyes, brows, mouth/jaw, smile, frown, surprise, anger, sadness, fear) with independent facial keyframes.
9. **Universal HTML & SDK Character Import**: Dependency/rig/facial analysis, live 3D import preview before adding, compatibility report, and documented `window.STAGECRAFT_SDK` contract.
10. **Independent Character Voice, Dialogue & Lip Sync**: Provider hook + Web Speech fallback, pitch/speed/volume/pan, microphone recording (`MediaRecorder`), dialogue split/combine/pause editing, phoneme/amplitude lip sync.
11. **Multi-Camera, Lighting, Props & Smart Scene Creation**: Perspective & Orthographic cameras, camera switching, framing presets (Wide, Medium, Close-Up, Extreme Close-Up, OTS, Tracking, Establishing), editable/keyable Directional/Point/Spot/Ambient lights, environment presets, procedural & GLB Props with parent-child bone attachment, scene templates.
12. **Production Video/Audio Export & Pro/Beginner UX**: Aspect ratios (16:9, 9:16, 1:1, 4:3), stepped frame pacing option, Command Palette (`Ctrl+K`), context menus, Beginner vs Advanced mode over unified project state.
