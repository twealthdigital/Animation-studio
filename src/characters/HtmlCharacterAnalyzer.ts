import type { CharacterActionDescriptor, CharacterImportMode } from './CharacterAdapter';

export interface HtmlCharacterAnalysis {
  title: string;
  suggestedName: string;
  usesThreeJs: boolean;
  threeVersion: string | null;
  recommendedMode: CharacterImportMode;
  globalApiHandle: string | null;
  sdkDetected: boolean;
  externalDependencies: string[];
  detectedGroupNames: string[];
  detectedBackdropHints: string[];
  rigHints: string[];
  facialHints: string[];
  moods: string[];
  actions: CharacterActionDescriptor[];
  supportsTalk: boolean;
  supportsSpeak: boolean;
  supportsLookAt: boolean;
  warnings: string[];
}

function formatActionLabel(id: string): string {
  const spaced = id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Inspects raw HTML source from a 3D character file (e.g., Globe, Host, or SDK-compliant
 * custom characters) without executing arbitrary scripts, extracting dependencies, rig
 * hints, facial controls, exposed API, moods, actions, and recommended import mode.
 */
export function analyzeHtmlCharacter(htmlSource: string, fallbackName = 'Imported Character'): HtmlCharacterAnalysis {
  const warnings: string[] = [];

  const titleMatch = htmlSource.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const suggestedName = title || fallbackName.replace(/\.html?$/i, '');

  const threeScriptMatch = htmlSource.match(/three(?:\.min)?\.js|from\s+['"]three['"]|new\s+THREE\./i);
  const usesThreeJs = Boolean(threeScriptMatch);
  const versionMatch = htmlSource.match(/three\.js\/r(\d+)|three@(\d+\.\d+\.\d+)/i);
  const threeVersion = versionMatch
    ? versionMatch[1]
      ? `r${versionMatch[1]}`
      : versionMatch[2]
    : null;

  // External script/asset dependencies
  const externalDependencies: string[] = [];
  for (const m of htmlSource.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    externalDependencies.push(m[1]);
  }
  for (const m of htmlSource.matchAll(/import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gi)) {
    if (!externalDependencies.includes(m[1])) externalDependencies.push(m[1]);
  }

  // Stagecraft SDK detection
  const sdkDetected = /STAGECRAFT_SDK|studioCharacter/.test(htmlSource);

  // Exposed global API handle
  const globalAssignMatches = [...htmlSource.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*|\{)/g)];
  const ignoredGlobals = new Set(['onload', 'onerror', 'onresize', 'THREE']);
  const apiCandidate = globalAssignMatches.find((m) => !ignoredGlobals.has(m[1]));
  const globalApiHandle = apiCandidate ? apiCandidate[1] : null;

  const groupMatches = [...htmlSource.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.Group\s*\(/g)];
  const detectedGroupNames = [...new Set(groupMatches.map((m) => m[1]))];

  const backdropCandidates = ['slat', 'back', 'floor', 'shadow', 'boom', 'mic', 'ring'];
  const detectedBackdropHints = backdropCandidates.filter((token) =>
    new RegExp(`\\b${token}[A-Za-z0-9_]*\\b`).test(htmlSource),
  );

  // Rig & facial hints
  const rigTokens = ['headPivot', 'armL', 'armR', 'legL', 'legR', 'Skeleton', 'Bone', 'SkinnedMesh', 'GLTFLoader'];
  const rigHints = rigTokens.filter((tok) => new RegExp(`\\b${tok}\\b`, 'i').test(htmlSource));

  const facialTokens = ['morphTarget', 'CanvasTexture', 'MOODS', 'blink', 'mouth', 'eyeL', 'eyeR', 'brow'];
  const facialHints = facialTokens.filter((tok) => new RegExp(`\\b${tok}\\b`, 'i').test(htmlSource));

  const moods: string[] = [];
  const moodsBlock = htmlSource.match(/const\s+MOODS\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (moodsBlock) {
    const keyMatches = [...moodsBlock[1].matchAll(/^\s*([a-zA-Z_]\w*)\s*:/gm)];
    for (const m of keyMatches) {
      if (!moods.includes(m[1])) moods.push(m[1]);
    }
  }
  const sdkMoodsMatch = htmlSource.match(/moods\s*:\s*\[([^\]]+)\]/);
  if (sdkMoodsMatch) {
    for (const m of sdkMoodsMatch[1].matchAll(/['"]([a-zA-Z0-9_-]+)['"]/g)) {
      if (!moods.includes(m[1])) moods.push(m[1]);
    }
  }

  const actionIds = new Set<string>();
  for (const m of htmlSource.matchAll(/data-act=["']([a-zA-Z0-9_-]+)["']/g)) {
    actionIds.add(m[1]);
  }
  const loopTokens = ['walk', 'ring', 'dance', 'run', 'idle'];
  const gestureTokens = ['nod', 'shake', 'tilt', 'hop', 'spin', 'flash', 'blink', 'wave', 'shrug', 'point', 'jump', 'sit', 'punch'];
  for (const token of [...gestureTokens, ...loopTokens]) {
    if (new RegExp(`\\b${token}\\s*\\(`).test(htmlSource)) {
      actionIds.add(token);
    }
  }

  const supportsTalk = /\btalk\s*\(/.test(htmlSource);
  const supportsSpeak = /\bspeak\s*\(/.test(htmlSource);
  const supportsLookAt = /\blookAt\s*\(/.test(htmlSource);

  const actions: CharacterActionDescriptor[] = [...actionIds].map((id) => ({
    id,
    label: formatActionLabel(id),
    kind: loopTokens.includes(id) ? 'loop' : 'gesture',
    supportsSpeed: loopTokens.includes(id),
    defaultDurationSec: loopTokens.includes(id) ? 2.0 : 1.0,
  }));

  const hasWebGLRenderer = /THREE\.WebGLRenderer/.test(htmlSource);
  const hasExternalModule = /<script[^>]+type=["']module["'][^>]+src=/.test(htmlSource);
  const recommendedMode: CharacterImportMode =
    usesThreeJs && hasWebGLRenderer && !hasExternalModule
      ? 'native-three-extraction'
      : 'isolated-iframe';

  if (!usesThreeJs) {
    warnings.push('No Three.js runtime detected; import will use Isolated HTML Sandbox mode with limited spatial controls.');
  } else if (hasExternalModule) {
    warnings.push('External ES module dependency detected; Isolated HTML Sandbox mode recommended unless bundled inline.');
  }
  if (!globalApiHandle && !sdkDetected) {
    warnings.push('No global API (window.<name> or window.STAGECRAFT_SDK) detected; hierarchy extraction and transforms still apply.');
  }

  return {
    title,
    suggestedName,
    usesThreeJs,
    threeVersion,
    recommendedMode,
    globalApiHandle,
    sdkDetected,
    externalDependencies,
    detectedGroupNames,
    detectedBackdropHints,
    rigHints,
    facialHints,
    moods,
    actions,
    supportsTalk,
    supportsSpeak,
    supportsLookAt,
    warnings,
  };
}
