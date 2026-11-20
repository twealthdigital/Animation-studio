import * as THREE from 'three';
import type { Transform3D } from '../core/types';
import type { CharacterCapabilities, ICharacterAdapter } from './CharacterAdapter';
import { analyzeHtmlCharacter } from './HtmlCharacterAnalyzer';

/**
 * Mode B Adapter: Fallback isolated sandbox iframe bridge for arbitrary non-Three.js
 * HTML characters. Renders a subtle studio locator proxy in the 3D scene while forwarding
 * supported studio commands to the sandboxed iframe via postMessage.
 */
export class HtmlIframeAdapter implements ICharacterAdapter {
  readonly instanceId: string;
  readonly assetId: string;
  readonly capabilities: CharacterCapabilities;
  readonly rootGroup = new THREE.Group();
  readonly htmlSource: string;

  private iframeEl: HTMLIFrameElement | null = null;
  private proxyMesh: THREE.Mesh;

  constructor(instanceId: string, assetId: string, htmlSource: string) {
    this.instanceId = instanceId;
    this.assetId = assetId;
    this.htmlSource = htmlSource;

    const analysis = analyzeHtmlCharacter(htmlSource);
    this.capabilities = {
      importMode: 'isolated-iframe',
      supportsTransform: false,
      supportsScale: false,
      supportsMotionPath: false,
      supportsAudioLipSync: analysis.supportsTalk,
      supportsSpeedControl: false,
      actions: analysis.actions,
      moods: analysis.moods,
      limitations: [
        ...analysis.warnings,
        'Isolated HTML mode runs inside a sandboxed frame; 3D transforms and motion paths are limited to the studio proxy.',
      ],
    };

    // Clean proxy marker in the 3D viewport so user sees spatial placement
    const geom = new THREE.BoxGeometry(1.1, 1.8, 0.25);
    geom.translate(0, 0.9, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3b4252,
      roughness: 0.6,
      metalness: 0.1,
    });
    this.proxyMesh = new THREE.Mesh(geom, mat);
    this.proxyMesh.userData.characterInstanceId = instanceId;
    this.rootGroup.add(this.proxyMesh);
  }

  attachIframe(iframe: HTMLIFrameElement | null): void {
    this.iframeEl = iframe;
  }

  private postCommand(command: string, payload?: unknown): void {
    this.iframeEl?.contentWindow?.postMessage(
      { type: 'studio:command', command, payload },
      '*',
    );
  }

  async load(): Promise<void> {
    // Handled by sandboxed iframe srcDoc mount
  }

  setTransform(transform: Transform3D): void {
    this.rootGroup.position.set(transform.position.x, transform.position.y, transform.position.z);
    this.rootGroup.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    this.rootGroup.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  setVisible(visible: boolean): void {
    this.rootGroup.visible = visible;
  }

  playAction(actionId: string): void {
    this.postCommand('playAction', { actionId });
  }

  setMood(mood: string): void {
    this.postCommand('setMood', { mood });
  }

  setTalking(active: boolean): void {
    this.postCommand('talk', { active });
  }

  pause(): void {
    this.postCommand('pause');
  }

  resume(): void {
    this.postCommand('resume');
  }

  reset(): void {
    this.postCommand('reset');
  }

  update(): void {
    // Frame updates run inside isolated sandbox
  }

  dispose(): void {
    this.proxyMesh.geometry.dispose();
    (this.proxyMesh.material as THREE.Material).dispose();
    this.rootGroup.clear();
    this.iframeEl = null;
  }
}
