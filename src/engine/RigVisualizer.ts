import * as THREE from 'three';
import type { IkChainType, IkTargetData, RigNodeInfo, SelectionTarget } from '../core/types';
import type { AnyCharacterAdapter } from '../characters/CharacterRegistry';

export interface RigVisualState {
  instanceId: string | null;
  poseModeInstanceId: string | null;
  ikTargets: readonly IkTargetData[];
  selection: SelectionTarget;
  hoveredNodeKey: string | null; // `${instanceId}:${nodeId}`
  lockedNodeIds: ReadonlySet<string>;
}

/**
 * Renders structured skeletal bone connectors, joint sockets, local rotation axis rings,
 * and distinct IK target handles inside `rigOverlayGroup` with shared base geometries
 * and camera-distance scaling.
 */
export class RigVisualizer {
  private readonly group: THREE.Group;
  private readonly jointSphereGeom = new THREE.SphereGeometry(0.068, 12, 10);
  private readonly jointRingGeom = new THREE.TorusGeometry(0.115, 0.012, 8, 24);
  private readonly boneLinkGeom = new THREE.CylinderGeometry(0.018, 0.036, 1, 6);
  private readonly axisRingGeom = new THREE.TorusGeometry(0.24, 0.012, 8, 32);
  private readonly ikDiamondGeom = new THREE.OctahedronGeometry(0.135, 0);
  private readonly ikAuraGeom = new THREE.TorusGeometry(0.2, 0.014, 8, 24);

  readonly rigNodeHandles = new Map<string, THREE.Mesh>();
  readonly ikHandles = new Map<string, THREE.Mesh>();
  private readonly scalableNodes: { obj: THREE.Object3D; worldPos: THREE.Vector3; baseScale: number }[] = [];
  private readonly disposedMaterials: THREE.Material[] = [];

  constructor(overlayGroup: THREE.Group) {
    this.group = overlayGroup;
    // Shift cylinder base so height spans 0..1 along +Y for clean lookAt/scale bone linking
    this.boneLinkGeom.translate(0, 0.5, 0);
    this.boneLinkGeom.rotateX(Math.PI / 2);
  }

  private trackMat<T extends THREE.Material>(mat: T): T {
    this.disposedMaterials.push(mat);
    return mat;
  }

  clear(): void {
    this.group.clear();
    this.rigNodeHandles.clear();
    this.ikHandles.clear();
    this.scalableNodes.length = 0;
    for (const m of this.disposedMaterials) {
      m.dispose();
    }
    this.disposedMaterials.length = 0;
  }

  rebuild(adapter: AnyCharacterAdapter | undefined, state: RigVisualState): void {
    this.clear();
    if (!state.instanceId || !adapter) return;
    if (!('getRigNodes' in adapter) || typeof adapter.getRigNodes !== 'function') return;

    const nodes: RigNodeInfo[] = adapter.getRigNodes();
    if (nodes.length === 0) return;

    adapter.rootGroup.updateMatrixWorld(true);
    const getNodeObj =
      'getNodeObject' in adapter && typeof adapter.getNodeObject === 'function'
        ? (id: string) => adapter.getNodeObject(id)
        : () => undefined;

    const posByNode = new Map<string, THREE.Vector3>();
    const quatByNode = new Map<string, THREE.Quaternion>();

    for (const node of nodes) {
      const obj = getNodeObj(node.nodeId);
      if (!obj || !obj.visible) continue;
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      obj.getWorldPosition(wp);
      obj.getWorldQuaternion(wq);
      posByNode.set(node.nodeId, wp);
      quatByNode.set(node.nodeId, wq);
    }

    const inPoseMode = state.poseModeInstanceId === state.instanceId;

    // 1. Draw parent -> child tapered bone connectors
    for (const node of nodes) {
      if (!node.parentId) continue;
      const parentPos = posByNode.get(node.parentId);
      const childPos = posByNode.get(node.nodeId);
      if (!parentPos || !childPos) continue;
      const len = parentPos.distanceTo(childPos);
      if (len < 0.03) continue;

      const isBranchActive =
        state.selection.kind === 'body-part' &&
        state.selection.instanceId === state.instanceId &&
        (state.selection.nodeId === node.nodeId || state.selection.nodeId === node.parentId);

      const linkMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: isBranchActive ? 0xe8702a : inPoseMode ? 0x38bdf8 : 0x64748b,
          transparent: true,
          opacity: isBranchActive ? 0.92 : inPoseMode ? 0.7 : 0.45,
          depthTest: false,
        }),
      );
      const linkMesh = new THREE.Mesh(this.boneLinkGeom, linkMat);
      linkMesh.renderOrder = 890;
      linkMesh.position.copy(parentPos);
      linkMesh.lookAt(childPos);
      linkMesh.scale.set(1, 1, len);
      this.group.add(linkMesh);
    }

    // 2. Draw articulated joint spheres + status rings
    for (const node of nodes) {
      if (node.type === 'mesh' && !node.slot && !inPoseMode) continue;
      const wp = posByNode.get(node.nodeId);
      const wq = quatByNode.get(node.nodeId);
      if (!wp || !wq) continue;

      const nodeKey = `${state.instanceId}:${node.nodeId}`;
      const isSelected =
        state.selection.kind === 'body-part' &&
        state.selection.instanceId === state.instanceId &&
        state.selection.nodeId === node.nodeId;
      const isHovered = state.hoveredNodeKey === nodeKey;
      const isLocked = state.lockedNodeIds.has(node.nodeId);

      const baseColor = isLocked
        ? 0xef4444
        : isSelected
          ? 0xe8702a
          : isHovered
            ? 0x67e8f9
            : node.slot
              ? 0x38bdf8
              : 0x94a3b8;

      const jointMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: baseColor,
          depthTest: false,
        }),
      );
      const jointMesh = new THREE.Mesh(this.jointSphereGeom, jointMat);
      jointMesh.renderOrder = isSelected ? 915 : 900;
      jointMesh.position.copy(wp);
      jointMesh.userData.rigNodeHandle = {
        instanceId: state.instanceId,
        nodeId: node.nodeId,
        nodeName: node.name,
        description: node.description ?? `Rotate ${node.name}`,
        locked: isLocked,
      };

      const scaleMul = isSelected ? 1.35 : isHovered ? 1.25 : node.slot ? 1.0 : 0.78;
      this.group.add(jointMesh);
      this.rigNodeHandles.set(nodeKey, jointMesh);
      this.scalableNodes.push({ obj: jointMesh, worldPos: wp.clone(), baseScale: scaleMul });

      // Halo ring for mapped/selected/hovered joints
      if (isSelected || isHovered || isLocked || (inPoseMode && node.slot)) {
        const ringMat = this.trackMat(
          new THREE.MeshBasicMaterial({
            color: isLocked ? 0xf87171 : isSelected ? 0xfdba74 : isHovered ? 0xa5f3fc : 0x7dd3fc,
            transparent: true,
            opacity: isSelected || isHovered ? 0.95 : 0.55,
            depthTest: false,
          }),
        );
        const halo = new THREE.Mesh(this.jointRingGeom, ringMat);
        halo.renderOrder = 905;
        halo.position.copy(wp);
        halo.quaternion.copy(wq);
        this.group.add(halo);
        this.scalableNodes.push({ obj: halo, worldPos: wp.clone(), baseScale: isSelected ? 1.2 : 1.0 });
      }

      // Three clear orthogonal local rotation guide rings on the active selected joint
      if (isSelected && !isLocked) {
        const ringHolder = new THREE.Group();
        ringHolder.position.copy(wp);
        ringHolder.quaternion.copy(wq);

        const xMat = this.trackMat(new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.75, depthTest: false }));
        const xRing = new THREE.Mesh(this.axisRingGeom, xMat);
        xRing.rotation.y = Math.PI / 2;
        xRing.renderOrder = 908;

        const yMat = this.trackMat(new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.75, depthTest: false }));
        const yRing = new THREE.Mesh(this.axisRingGeom, yMat);
        yRing.rotation.x = Math.PI / 2;
        yRing.renderOrder = 908;

        const zMat = this.trackMat(new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.75, depthTest: false }));
        const zRing = new THREE.Mesh(this.axisRingGeom, zMat);
        zRing.renderOrder = 908;

        ringHolder.add(xRing, yRing, zRing);
        this.group.add(ringHolder);
        this.scalableNodes.push({ obj: ringHolder, worldPos: wp.clone(), baseScale: 1.0 });
      }
    }

    // 3. Distinct IK target diamond handles
    for (const ik of state.ikTargets) {
      if (!ik.enabled) continue;
      const isSelectedIk =
        state.selection.kind === 'ik-handle' &&
        state.selection.instanceId === state.instanceId &&
        state.selection.chain === ik.chain;

      const worldTarget = new THREE.Vector3(ik.target.x, ik.target.y, ik.target.z).applyMatrix4(
        adapter.rootGroup.matrixWorld,
      );

      const ikMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: isSelectedIk ? 0xfacc15 : 0x4ade80,
          depthTest: false,
        }),
      );
      const mesh = new THREE.Mesh(this.ikDiamondGeom, ikMat);
      mesh.renderOrder = 920;
      mesh.position.copy(worldTarget);
      mesh.userData.ikHandle = {
        instanceId: state.instanceId,
        chain: ik.chain as IkChainType,
      };
      this.group.add(mesh);
      this.ikHandles.set(`${state.instanceId}:${ik.chain}`, mesh);
      this.scalableNodes.push({ obj: mesh, worldPos: worldTarget.clone(), baseScale: isSelectedIk ? 1.25 : 1.0 });

      const auraMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: isSelectedIk ? 0xfef08a : 0x86efac,
          transparent: true,
          opacity: 0.75,
          depthTest: false,
        }),
      );
      const aura = new THREE.Mesh(this.ikAuraGeom, auraMat);
      aura.rotation.x = Math.PI / 2;
      aura.renderOrder = 918;
      aura.position.copy(worldTarget);
      this.group.add(aura);
      this.scalableNodes.push({ obj: aura, worldPos: worldTarget.clone(), baseScale: 1.0 });
    }
  }

  /**
   * Keeps joints, halos, and rotation rings legible across close-up hand zooms and wide stage shots.
   */
  updateScales(camera: THREE.Camera): void {
    const camPos = camera.position;
    for (const item of this.scalableNodes) {
      const dist = camPos.distanceTo(item.worldPos);
      const factor = THREE.MathUtils.clamp(dist / 7.5, 0.45, 2.2) * item.baseScale;
      item.obj.scale.setScalar(factor);
    }
  }

  dispose(): void {
    this.clear();
    this.jointSphereGeom.dispose();
    this.jointRingGeom.dispose();
    this.boneLinkGeom.dispose();
    this.axisRingGeom.dispose();
    this.ikDiamondGeom.dispose();
    this.ikAuraGeom.dispose();
  }
}
