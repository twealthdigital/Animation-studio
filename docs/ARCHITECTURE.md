# Stagecraft 3D — Technical Architecture

## 1. Existing Project & Character Inspection (Stage 0)

### Repository Baseline
- **Build & Runtime**: Vite 8, React 19, TypeScript 7, Tailwind CSS v4 (`@tailwindcss/vite`), `lucide-react`, `three` + `@types/three`.
- **Starting State**: Clean Vite/React template (`src/App.tsx`, `src/main.tsx`, `src/index.css`) with no existing 3D engine or studio UI.
- **Reference Character Assets** (in `public/assets/aistudio/`):
  - `Globe_character_2c73ff07.html` — Self-contained HTML/Three.js (`r128` via CDN) character (`window.globe`), procedural `THREE.Group` (`bot`) with icosahedron shell, drum face housing, dynamic 512x512 `CanvasTexture` facial expression renderer, ear pods, antenna, orbiting ring, plus stage props (backdrop slats, boom mic, floor shadow). Exposes `setMood`, `talk`, `speak`, `blink`, `nod`, `shake`, `tilt`, `hop`, `spin`, `flash`, `ring`, `lookAt`.
  - `Host_character_ed9211ab.html` — Self-contained HTML/Three.js (`r128` via CDN) character (`window.guy`), procedural `THREE.Group` (`guy`) with `CanvasTexture` printed torso, articulated `headPivot`, eyes/pupils/brows/mouth/teeth/tongue, articulated arms (`sh`, `el`, `hand`) and legs (`hip`, `knee`), plus animated floor disc. Exposes `setMood`, `talk`, `speak`, `blink`, `nod`, `shake`, `wave`, `shrug`, `point`, `walk`, `lookAt`.

## 2. Selected Stack & Core Separation

- **UI Layer (React 19 + Tailwind CSS v4)**: Desktop creative-studio workspace (top bar, left asset/hierarchy panel, center viewport host, right contextual inspector, bottom resizable timeline). React owns declarative UI panels and user controls, never a 60Hz `requestAnimationFrame` render loop.
- **Core State & Event Bus (`src/core/`)**: Typed `EventBus`, immutable/command-driven `StateManager`, and undo/redo `CommandManager` so UI, engine, timeline, and persistence remain decoupled.
- **3D Engine (`src/engine/`)**: Imperative Three.js subsystem mounted once into a dedicated `<div ref>` container. Maintains separate `editorCamera` (OrbitControls) and `sceneCamera` (animated final output camera), three-point lighting + `RoomEnvironment`, raycast selection, `TransformControls` gizmos, software-WebGL pacing guard, and deterministic disposal.
- **Character System (`src/characters/`)**: Unified `ICharacterAdapter` contract supporting multiple independent instances per scene.
- **Animation & Paths (`src/animation/`)**: Deterministic time-evaluated keyframe tracks, easing curves, and Bezier/Catmull-Rom motion paths (no frame-accumulation drift).
- **Audio System (`src/audio/`)**: Web Audio API mixer with per-character voice profiles, independent character dialogue tracks, music/SFX tracks, and real decoded audio waveforms.
- **Persistence (`src/storage/`)**: IndexedDB repositories storing binary assets (`Blob`/`ArrayBuffer`) separately from lightweight JSON scene/project metadata.
- **Export (`src/engine/ExportManager.ts`)**: Offscreen/isolated scene-camera rendering combined with mixed Web Audio streams via `MediaRecorder` (with accurate capability detection for WebM/MP4).

## 3. HTML Character Import Architecture (Dual-Mode)

Because users supply existing 3D characters packaged as standalone HTML files, importing supports two complementary compatibility modes behind a single `ICharacterAdapter` interface:

### Mode A — Native Three.js Scene Extraction (Primary for Three.js HTML Characters)
Designed for characters like `Globe_character` and `Host_character`:
1. **Static Inspection (`HtmlCharacterAnalyzer`)**: Parses the HTML document, identifies Three.js usage, extracts title/scripts, detects exposed character API objects (`window.globe`, `window.guy`, `window.character`, etc.), moods, and gesture actions (`[data-act]`, API methods).
2. **Controlled Runtime Shim**: Executes the character's initialization script inside an isolated scope with a Three.js compatibility bridge and virtual stage DOM, intercepting `THREE.Scene`, `THREE.WebGLRenderer`, `requestAnimationFrame`, and `window.<api>`.
3. **Unified Stage Mounting**: Extracts the primary character `THREE.Group` (with an option to exclude or include surrounding stage/backdrop meshes) directly into the Studio's master `THREE.Scene`, driving the character's internal procedural tick (`CanvasTexture` face animation, blinking, breathing, walk cycle) deterministically from the Studio clock.
4. **Benefits**: Multiple imported HTML characters stand together in the same 3D scene, share the Studio's cameras and lights, support raycast selection, `TransformControls`, keyframe transforms, and editable motion paths.

### Mode B — Isolated HTML Sandbox + PostMessage Bridge (Fallback for Arbitrary HTML)
Designed for self-contained HTML apps that use incompatible engines or cannot be natively extracted:
1. Renders inside `<iframe sandbox="allow-scripts">` with zero direct access to the main studio DOM or state.
2. Communicates via a strict `postMessage` contract (`studio:command` / `studio:event`) for supported actions, mood changes, speech/talking state, and lifecycle controls.
3. Explicitly surfaces capability limits in the Inspector rather than faking bone or transform control.

## 4. Folder Structure

```text
src/
  core/        EventBus, Command/History interfaces, core state types
  engine/      (Stage 2+) Three.js renderer, scene, cameras, lighting, gizmos
  characters/  Character types, adapter contract, HtmlCharacterAnalyzer
  animation/   (Stage 6+) Keyframes, interpolation, motion paths, timeline model
  audio/       (Stage 9+) Web Audio mixer, character voice profiles, clips
  scenes/      (Stage 11+) Multi-scene management & serialization
  storage/     (Stage 12+) IndexedDB repositories
  ui/          Reusable primitives, layout shell, panels
  utils/       Deterministic IDs, math helpers, time formatting
  styles/      Studio design tokens & custom scrollbar styles
docs/
  ARCHITECTURE.md
  PROJECT_PLAN.md
  PROGRESS.md
  DECISIONS.md
  IMPORT_FORMAT.md
```
