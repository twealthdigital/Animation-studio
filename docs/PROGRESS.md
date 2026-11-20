# Stagecraft 3D — Development Progress

## Current Stage
**Studio Precision, Articulation & Workflow Upgrade** (Completed & Verified)

## Completed Architecture & Upgrades
- **Hover-to-Identify System (`StudioEngine`, `CenterViewport`)**: Throttled viewport raycast highlights hovered parts/bones/props/groups with non-destructive cyan emissive + `hoverBoxHelper`, resolving auxiliary mesh hits to their controlling parent joint (e.g. `Head • Left Eye`) and displaying cursor-near control tooltips without changing selection.
- **Single-Click vs Double-Click Articulated Pose Mode (`StudioEngine`, `HtmlThreeAdapter`, `GltfCharacterAdapter`, `RigVisualizer`)**: Single-click selects objects/groups with transform gizmos; double-click enters socket-locked Pose Mode where child joints rotate smoothly around parent pivots (zero detachment), supporting direct camera-aligned pointer drag-to-rotate (`Alt+Drag` roll) and interactive local X/Y/Z arrowhead rotation rings without overlapping `TransformControls`.
- **Upgraded Rig Visualization & Auxiliary Filtering (`RigVisualizer`, `LeftAssetPanel`, `RigAndFacialInspector`)**: Faceted gimbal joint sockets, tapered octahedral bone prisms, directional arrowhead X/Y/Z rings, and a `Joints Only` / `All Parts` filter hiding facial/accessory clutter (`isAuxiliary`) by default.
- **Logical Grouping & Object Structure (`GroupUtils`, `LeftAssetPanel`, `RightInspector`)**: `SceneGroupData` (`Ctrl+G` Group, `Ctrl+Shift+G` Ungroup preserving world transforms, `Duplicate Group` with member cloning & offset, inline Rename, Select Members, Lock/Hide/Isolate, animated group tracks) plus `Shift+Click` multi-select.
- **Independent Camera & Focused Zoom (`StudioEngine`, `CenterViewport`)**: `Persp / Ortho` editor projection toggle, `Free / Front / Back / Left / Right / Top / Bottom` presets, `zoomToCursor`, damped Focused Zoom (`F`), and Frame All (`Shift+F`).
- **Universal Undo/Redo & Keyframe Sync (`CommandManager`, `StudioWorkspace`, `HtmlThreeAdapter`)**: Coalesced snapshot Undo/Redo (`Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`) across scene transforms, FPS, asset renames, group edits, and rig poses; fixes Undo pose snap-back and syncs drag-to-move/rotate on already-keyframed objects directly into the active playhead keyframe.
- **Timeline, Motion Paths & `Tab` Prediction HUD (`BottomTimeline`, `GraphEditor`, `TabSuggestionHud`)**: Solid diamond keyframe editing (`Shift+F10` / `Delete` keyboard support), 3D motion path markers, Bezier curves, and non-intrusive `Tab` motion prediction (`Preview`, undoable `Apply`, `↑/↓` Cycle, `Esc` Dismiss).
- **Solid Contrast UI, Custom Tooltips & Responsive Panels (`Primitives`, `StudioWorkspace`, Panels)**: Delayed global `StudioTooltipHost` (`data-studio-note` + `shortcut`), concise labels with crisp solid selected/active states, collapsible `Expanded / Compact / Collapsed` panels, `Shift+F10` context menus across viewport/hierarchy/timeline, and automatic compact adaptation on narrow viewports.

## Verification & Quality Status
- **Unit Tests**: Pure-logic tests pass via `npx --yes tsx --test src/**/*.test.ts` (`GroupUtils`, `SceneEvaluator`, `MotionPresets`, `Interpolation`, `MotionPath`, `IkSolver`, `RigMapper`, `HtmlCharacterAnalyzer`, `CommandManager`, `EventBus`, `math`, `timeUtils`, `ids`).
- **Build & Typecheck**: `npm run build` and `npm run lint` (`tsc --noEmit`) verified after final edit.
