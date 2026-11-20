import type { AssetRecord } from '../core/types';
import { GltfCharacterAdapter } from './GltfCharacterAdapter';
import { HtmlIframeAdapter } from './HtmlIframeAdapter';
import { HtmlThreeAdapter } from './HtmlThreeAdapter';

export type AnyCharacterAdapter = HtmlThreeAdapter | HtmlIframeAdapter | GltfCharacterAdapter;

export function createCharacterAdapter(
  instanceId: string,
  asset: AssetRecord,
  options: { includeStageProps?: boolean; glbBinary?: ArrayBuffer } = {},
): AnyCharacterAdapter {
  if (asset.kind === 'character-glb') {
    if (!options.glbBinary) {
      throw new Error(`Missing binary data for GLB/GLTF asset "${asset.name}".`);
    }
    return new GltfCharacterAdapter(instanceId, asset.id, options.glbBinary);
  }

  const html = asset.htmlSource ?? '';
  if (asset.htmlAnalysis?.recommendedMode === 'isolated-iframe') {
    return new HtmlIframeAdapter(instanceId, asset.id, html);
  }

  return new HtmlThreeAdapter(instanceId, asset.id, html, options.includeStageProps ?? false);
}
