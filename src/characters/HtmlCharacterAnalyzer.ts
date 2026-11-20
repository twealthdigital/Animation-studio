import type { CharacterActionDescriptor, CharacterImportMode } from './CharacterAdapter';

export interface HtmlCharacterAnalysis {
  title: string;
  suggestedName: string;
  usesThreeJs: boolean;
  threeVersion: string | null;
  recommendedMode: CharacterImportMode;
  isFullScene: boolean;
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
 * Inspects raw HTML source from a 3D character or full animated Three.js scene/video HTML file
 * without executing arbitrary scripts, extracting dependencies, rig hints, moods, actions,
 * and whether it represents a full multi-object animated scene.
 */
export function analyzeHtmlCharacter(htmlSource: string, fallbackName = 'Imported Scene'): HtmlCharacterAnalysis {
  const warnings: string[] = [];

  const titleMatch = htmlSource.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const suggestedName = title || fallbackName.replace(/\.html?$/i, '');

  const usesThreeImport =
    /from\s+['"][^'"]*three[^'"]*['"]/i.test(htmlSource) ||
    /three(?:\.min|\.module)?\.js/i.test(htmlSource) ||
    /new\s+THREE\./i.test(htmlSource) ||
    /"three"\s*:/i.test(htmlSource);
  const usesThreeJs = Boolean(usesThreeImport);
  const versionMatch = htmlSource.match(/three\.js\/r(\d+)|three@(\d+\.\d+\.\d+)/i);
  const threeVersion = versionMatch
    ? versionMatch[1]
      ? `r${versionMatch[1]}`
      : versionMatch[2]
    : null;

  // External script/asset dependencies (ignore importmap & known Three.js CDN scripts handled natively)
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

  const backdropCandidates = ['slat', 'back', 'floor', 'shadow', 'boom', 'mic', 'ring', 'ground', 'sky', 'sun', 'wall', 'room'];
  const detectedBackdropHints = backdropCandidates.filter((token) =>
    new RegExp(`\\b${token}[A-Za-z0-9_]*\\b`, 'i').test(htmlSource),
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

  const hasInlineScript = /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i.test(htmlSource);
  const hasWebGLRenderer = /WebGLRenderer/.test(htmlSource);
  const hasExternalModuleSrcOnly =
    /<script[^>]+type=["']module["'][^>]+src=/i.test(htmlSource) && !hasInlineScript;
  const nonThreeExternalLibs = externalDependencies.filter(
    (dep) => !/three|importmap|orbitcontrols|roomenvironment|roundedbox/i.test(dep),
  );

  // Full-scene / coded HTML video detection (multiple scene adds, lights, animation loop, camera choreography)
  const sceneAddMatches = htmlSource.match(/\bscene\.add\s*\(/g) ?? [];
  const hasAnimationLoop =
    /requestAnimationFrame|setAnimationLoop/.test(htmlSource);
  const isFullScene =
    !sdkDetected &&
    !globalApiHandle &&
    (sceneAddMatches.length >= 2 || (hasAnimationLoop && detectedBackdropHints.length >= 2));

  const recommendedMode: CharacterImportMode =
    usesThreeJs && hasInlineScript && !hasExternalModuleSrcOnly && (hasWebGLRenderer || /new\s+(?:THREE\.)?Scene\s*\(/.test(htmlSource))
      ? 'native-three-extraction'
      : 'isolated-iframe';

  if (!usesThreeJs) {
    warnings.push('No Three.js runtime detected; import will use Isolated HTML Sandbox mode.');
  } else if (hasExternalModuleSrcOnly) {
    warnings.push('External ES module src script detected; Isolated HTML Sandbox mode recommended unless bundled inline.');
  } else if (nonThreeExternalLibs.length > 0) {
    warnings.push(`External dependency referenced (${nonThreeExternalLibs.join(', ')}); non-Three globals may be stubbed.`);
  }

  if (isFullScene && recommendedMode === 'native-three-extraction') {
    warnings.push('Full coded 3D scene detected — all objects, lights & animation will play together and can be baked to Timeline keyframes for editing.');
  } else if (!globalApiHandle && !sdkDetected) {
    warnings.push('All 3D parts & procedural movements will be extracted for interactive clicking, recoloring & keyframing.');
  }

  return {
    title,
    suggestedName,
    usesThreeJs,
    threeVersion,
    recommendedMode,
    isFullScene,
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
