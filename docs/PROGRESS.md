# Stagecraft 3D — Development Progress

## Current Stage
**Studio Precision, Articulation & Workflow Upgrade** (Completed & Verified)

## Completed Architecture & Upgrades
- **Hover-to-Identify System (`StudioEngine`, `CenterViewport`)**: Throttled viewport raycast highlights hovered parts/bones/props/groups with non-destructive cyan emissive + `hoverBoxHelper` and displays cursor-near tooltip with node title, control note, and `[Locked]` status.
- **Single-Click vs Double-Click Articulated Pose Mode (`StudioEngine`, `HtmlThreeAdapter`, `GltfCharacterAdapter`, `RigVisualizer`)**: Single-click selects objects/groups with transform gizmos; double-click enters Articulated Pose Mode keeping child bones locked to their parent socket pivot (zero detachment), supports direct pointer drag-to-rotate on body parts, prevents rest-rotation double-counting, and renders clear parent->child connectors, socket rings, local X/Y/Z axis rings, and IK diamond handles.
- **Logical Grouping & Object Structure (`GroupUtils`, `LeftAssetPanel`, `RightInspector`)**: `SceneGroupData` (`Ctrl+G` Group, `Ctrl+Shift+G` Ungroup preserving world transforms, Lock/Hide/Isolate, animated group tracks), per-node Lock/Hide toggles, and material + bone structure inspection.
- **Independent Camera & Focused Zoom (`StudioEngine`, `CenterViewport`)**: `Persp / Ortho` editor projection toggle, `Free / Front / Back / Left / Right / Top / Bottom` presets, `zoomToCursor`, damped Focused Zoom (`F`), and Frame All (`Shift+F`).
- **Universal Undo/Redo (`CommandManager`, `StudioWorkspace`)**: Snapshot-backed `commitSceneMutation` with 480ms drag/slider coalescing so `Ctrl+Z` and `Ctrl+Shift+Z` / `Ctrl+Y` cleanly undo and redo every scene mutation.
- **Advanced Timeline, Motion Paths & Curve Editing (`BottomTimeline`, `GraphEditor`, `StudioEngine`)**: Expandable per-channel/per-bone tracks, keyframe multi-select/drag-move/copy-paste/duplicate/easing/delete, 3D motion path directional markers, and draggable Bezier tangent handles (`Smooth` vs `Broken`) + time zoom/pan.
- **Tab Animation Prediction HUD (`MotionPresets`, `TabSuggestionHud`)**: Non-intrusive `Tab`-triggered overlay with `Preview`, `Apply` (undoable), `↑/↓` Cycle, `Esc` Dismiss, and honest rig-incompatibility notes.
- **Collapsible Panels, Workspace Presets & `Shift+F10` Context Menu**: `Expanded / Compact / Collapsed` states for Left, Right, and Timeline panels; 6 persisted `WorkspaceLayoutId` presets (`general`, `animation`, `rigging`, `scene`, `audio`, `camera`); complete keyboard shortcuts + `Shift+F10` menu documented in `UserGuideDialog`.

## Verification & Quality Status
- **Unit Tests**: 25/25 pure-logic tests pass via `npx --yes tsx --test` (`GroupUtils`, `SceneEvaluator`, `MotionPresets`, `Interpolation`, `MotionPath`, `IkSolver`, `RigMapper`, `HtmlCharacterAnalyzer`, `CommandManager`, `EventBus`, `math`, `timeUtils`, `ids`).
- **Build & Typecheck**: `compile_applet` (`npm run build`) and `lint_applet` (`tsc --noEmit`) verified after final edit.
- **Packaged Archive**: Regenerated `/public/downloads/stagecraft-3d-studio.zip` excluding build/cache/download artifacts.
