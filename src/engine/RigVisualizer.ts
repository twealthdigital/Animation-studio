import * as THREE from 'three';
import type { IkChainType, IkTargetData, RigNodeInfo, SelectionTarget } from '../core/types';
import type { AnyCharacterAdapter } from '../characters/CharacterRegistry';

export interface RigVisualState {
  instanceId: string | null;
  poseModeInstanceId: string | null;
  ikTargets: readonly IkTargetData[];
  selection: SelectionTarget;
  hoveredNodeKey: string | null; // `${instanceId}:${nodeId}`
  multiSelectedNodeKeys?: ReadonlySet<string>;
  hoveredRingAxis?: 'x' | 'y' | 'z' | null;
  activeRingAxis?: 'x' | 'y' | 'z' | null;
  lockedNodeIds: ReadonlySet<string>;
}

interface LiveBoneLink {
  mesh: THREE.Mesh;
  parentNodeId: string;
  childNodeId: string;
}

interface LiveNodeAnchor {
  obj: THREE.Object3D;
  nodeId: string;
  worldPos: THREE.Vector3;
  baseScale: number;
  copyQuat: boolean;
}

/**
 * Renders structured skeletal tapered bone prisms, faceted gimbal joint sockets,
 * interactive local X/Y/Z rotation rings with directional arrowheads,
 * and distinct IK target handles inside `rigOverlayGroup`.
 */
export class RigVisualizer {
  private readonly group: THREE.Group;

  // Shared geometries disposed on engine teardown
  private readonly socketCoreGeom = new THREE.OctahedronGeometry(0.056, 0);
  private readonly socketCollarGeom = new THREE.TorusGeometry(0.098, 0.013, 8, 24);
  private readonly rootRingGeom = new THREE.TorusGeometry(0.28, 0.014, 8, 32);
  private readonly bonePrismGeom = new THREE.CylinderGeometry(0.011, 0.044, 1, 4);
  private readonly axisRingGeom = new THREE.TorusGeometry(0.32, 0.015, 10, 48);
  private readonly axisRingHitGeom = new THREE.TorusGeometry(0.32, 0.055, 8, 28);
  private readonly axisArrowGeom = new THREE.ConeGeometry(0.04, 0.105, 8);
  private readonly ikDiamondGeom = new THREE.OctahedronGeometry(0.135, 0);
  private readonly ikAuraGeom = new THREE.TorusGeometry(0.2, 0.014, 8, 24);

  readonly rigNodeHandles = new Map<string, THREE.Mesh>();
  readonly axisRingHandles: THREE.Mesh[] = [];
  readonly ikHandles = new Map<string, THREE.Mesh>();

  private readonly liveBoneLinks: LiveBoneLink[] = [];
  private readonly liveNodeAnchors: LiveNodeAnchor[] = [];
  private readonly ikScalables: { obj: THREE.Object3D; worldPos: THREE.Vector3; baseScale: number }[] = [];
  private readonly disposedMaterials: THREE.Material[] = [];

  private readonly tmpParentPos = new THREE.Vector3();
  private readonly tmpChildPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(overlayGroup: THREE.Group) {
    this.group = overlayGroup;
    // Align 4-sided tapered bone prism along +Z spanning 0..1 for clean lookAt & Z-length scaling
    this.bonePrismGeom.rotateY(Math.PI / 4);
    this.bonePrismGeom.translate(0, 0.5, 0);
    this.bonePrismGeom.rotateX(Math.PI / 2);
    // Point directional arrowheads along +Z for tangent mounting on rings
    this.axisArrowGeom.rotateX(Math.PI / 2);
  }

  private trackMat<T extends THREE.Material>(mat: T): T {
    this.disposedMaterials.push(mat);
    return mat;
  }

  clear(): void {
    this.group.clear();
    this.rigNodeHandles.clear();
    this.axisRingHandles.length = 0;
    this.ikHandles.clear();
    this.liveBoneLinks.length = 0;
    this.liveNodeAnchors.length = 0;
    this.ikScalables.length = 0;
    for (const m of this.disposedMaterials) {
      m.dispose();
    }
    this.disposedMaterials.length = 0;
  }

  private buildAxisRing(
    ringHolder: THREE.Group,
    axis: 'x' | 'y' | 'z',
    colorHex: number,
    instanceId: string,
    nodeId: string,
    nodeName: string,
    isHighlighted: boolean,
  ): void {
    const axisGroup = new THREE.Group();
    if (axis === 'x') {
      axisGroup.rotation.y = Math.PI / 2;
    } else if (axis === 'y') {
      axisGroup.rotation.x = Math.PI / 2;
    }

    const ringMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: isHighlighted ? 1.0 : 0.78,
        depthTest: false,
      }),
    );
    const ringMesh = new THREE.Mesh(this.axisRingGeom, ringMat);
    ringMesh.renderOrder = isHighlighted ? 930 : 914;
    if (isHighlighted) ringGroupScale(axisGroup, 1.07);
    axisGroup.add(ringMesh);

    // Dual directional arrowheads showing clear positive rotation flow
    const arrowMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: isHighlighted ? 1.0 : 0.92,
        depthTest: false,
      }),
    );
    const r = 0.32;
    const arrowTop = new THREE.Mesh(this.axisArrowGeom, arrowMat);
    arrowTop.position.set(0, r, 0);
    arrowTop.rotation.y = -Math.PI / 2; // tangent around local +Z ring
    arrowTop.renderOrder = 916;

    const arrowBot = new THREE.Mesh(this.axisArrowGeom, arrowMat);
    arrowBot.position.set(0, -r, 0);
    arrowBot.rotation.y = Math.PI / 2;
    arrowBot.renderOrder = 916;

    axisGroup.add(arrowTop, arrowBot);

    // Generous transparent raycast torus for effortless picking & dragging
    const hitMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      }),
    );
    const hitMesh = new THREE.Mesh(this.axisRingHitGeom, hitMat);
    hitMesh.renderOrder = 915;
    const axisLabel = axis === 'x' ? 'Pitch (X)' : axis === 'y' ? 'Yaw / Twist (Y)' : 'Roll / Tilt (Z)';
    hitMesh.userData.rigRotationRing = {
      instanceId,
      nodeId,
      nodeName,
      axis,
      title: `${nodeName} • ${axisLabel}`,
      description: `Drag ring to rotate ${nodeName} around local ${axis.toUpperCase()} axis`,
    };
    axisGroup.add(hitMesh);
    this.axisRingHandles.push(hitMesh);

    ringHolder.add(axisGroup);
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
    const nodeById = new Map<string, RigNodeInfo>();

    const isNodeVisible = (obj: THREE.Object3D): boolean => {
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        if (!cur.visible || cur.userData?.__detachedHidden === true) return false;
        if (cur === adapter.rootGroup) return true;
        cur = cur.parent;
      }
      return true;
    };

    for (const node of nodes) {
      nodeById.set(node.nodeId, node);
      const obj = getNodeObj(node.nodeId);
      if (!obj || !isNodeVisible(obj)) continue;
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      obj.getWorldPosition(wp);
      obj.getWorldQuaternion(wq);
      posByNode.set(node.nodeId, wp);
      quatByNode.set(node.nodeId, wq);
    }

    const inPoseMode = state.poseModeInstanceId === state.instanceId;
    const selectedNodeId =
      state.selection.kind === 'body-part' && state.selection.instanceId === state.instanceId
        ? state.selection.nodeId
        : null;

    // 1. Draw parent -> child tapered octahedral bone prisms (skipping auxiliary facial clutter unless selected/multi-selected)
    for (const node of nodes) {
      if (!node.parentId) continue;
      const nodeKey = `${state.instanceId}:${node.nodeId}`;
      const isNodeSelected = selectedNodeId === node.nodeId || Boolean(state.multiSelectedNodeKeys?.has(nodeKey));
      if (node.isAuxiliary && !isNodeSelected) continue;

      const parentPos = posByNode.get(node.parentId);
      const childPos = posByNode.get(node.nodeId);
      if (!parentPos || !childPos) continue;
      const len = parentPos.distanceTo(childPos);
      if (len < 0.04) continue;

      const isBranchActive =
        isNodeSelected || (selectedNodeId !== null && selectedNodeId === node.parentId);

      const boneColor = isBranchActive ? 0xe8702a : inPoseMode ? 0x38bdf8 : 0x64748b;
      const linkMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: boneColor,
          emissive: boneColor,
          emissiveIntensity: isBranchActive ? 0.55 : inPoseMode ? 0.32 : 0.18,
          roughness: 0.35,
          metalness: 0.2,
          flatShading: true,
          transparent: true,
          opacity: isBranchActive ? 0.92 : inPoseMode ? 0.72 : 0.42,
          depthTest: false,
        }),
      );
      const linkMesh = new THREE.Mesh(this.bonePrismGeom, linkMat);
      linkMesh.renderOrder = 890;
      linkMesh.position.copy(parentPos);
      linkMesh.lookAt(childPos);
      linkMesh.scale.set(1, 1, len);
      this.group.add(linkMesh);
      this.liveBoneLinks.push({
        mesh: linkMesh,
        parentNodeId: node.parentId,
        childNodeId: node.nodeId,
      });
    }

    // 2. Draw articulated gimbal joint sockets + interactive X/Y/Z arrowhead rotation rings
    for (const node of nodes) {
      const nodeKey = `${state.instanceId}:${node.nodeId}`;
      const isSelected = selectedNodeId === node.nodeId;
      const isMultiSelected = Boolean(state.multiSelectedNodeKeys?.has(nodeKey));
      const isHovered = state.hoveredNodeKey === nodeKey;
      const isLocked = state.lockedNodeIds.has(node.nodeId);
      const isComponentGroup = node.type === 'group' && node.nodeId.startsWith('cgrp_');

      // Keep face & minor decorative sub-parts clean unless explicitly selected, multi-selected, hovered, or component-grouped
      if (node.isAuxiliary && !isSelected && !isMultiSelected && !isHovered && !isComponentGroup) continue;
      if (node.type === 'mesh' && !node.slot && !inPoseMode && !isSelected && !isMultiSelected && !isHovered) continue;

      const wp = posByNode.get(node.nodeId);
      const wq = quatByNode.get(node.nodeId);
      if (!wp || !wq) continue;

      const isRoot = node.nodeId === 'node_0';
      const baseColor = isLocked
        ? 0xef4444
        : isSelected
          ? 0xe8702a
          : isMultiSelected
            ? 0x38bdf8
            : isHovered
              ? 0x67e8f9
              : isComponentGroup
                ? 0xf59e0b
                : node.slot
                  ? 0x38bdf8
                  : 0x94a3b8;

      if (isRoot) {
        // Subtle floor/origin anchor ring for Character Root rather than a floating center ball
        const rootMat = this.trackMat(
          new THREE.MeshBasicMaterial({
            color: isSelected ? 0xe8702a : isHovered ? 0x67e8f9 : 0x64748b,
            transparent: true,
            opacity: isSelected || isHovered ? 0.92 : 0.45,
            depthTest: false,
          }),
        );
        const rootRing = new THREE.Mesh(this.rootRingGeom, rootMat);
        rootRing.renderOrder = 895;
        rootRing.position.copy(wp);
        rootRing.quaternion.copy(wq);
        rootRing.rotateX(Math.PI / 2);
        rootRing.userData.rigNodeHandle = {
          instanceId: state.instanceId,
          nodeId: node.nodeId,
          nodeName: node.name,
          description: node.description ?? `Transform ${node.name}`,
          locked: isLocked,
        };
        this.group.add(rootRing);
        this.rigNodeHandles.set(nodeKey, rootRing);
        this.liveNodeAnchors.push({
          obj: rootRing,
          nodeId: node.nodeId,
          worldPos: wp.clone(),
          baseScale: isSelected ? 1.12 : 1.0,
          copyQuat: false,
        });
      } else {
        const jointMat = this.trackMat(
          new THREE.MeshStandardMaterial({
            color: baseColor,
            emissive: baseColor,
            emissiveIntensity: isSelected ? 0.65 : isHovered ? 0.55 : 0.35,
            roughness: 0.28,
            metalness: 0.25,
            flatShading: true,
            depthTest: false,
          }),
        );
        const jointMesh = new THREE.Mesh(this.socketCoreGeom, jointMat);
        jointMesh.renderOrder = isSelected ? 918 : 902;
        jointMesh.position.copy(wp);
        jointMesh.quaternion.copy(wq);
        jointMesh.userData.rigNodeHandle = {
          instanceId: state.instanceId,
          nodeId: node.nodeId,
          nodeName: node.name,
          description: node.description ?? `Rotate ${node.name}`,
          locked: isLocked,
        };

        const scaleMul = isSelected || isMultiSelected ? 1.32 : isHovered ? 1.24 : node.slot || isComponentGroup ? 1.0 : 0.78;
        this.group.add(jointMesh);
        this.rigNodeHandles.set(nodeKey, jointMesh);
        this.liveNodeAnchors.push({
          obj: jointMesh,
          nodeId: node.nodeId,
          worldPos: wp.clone(),
          baseScale: scaleMul,
          copyQuat: true,
        });

        // Socket collar ring around mapped / active / multi-selected / hovered / component-group joints
        if (isSelected || isMultiSelected || isHovered || isLocked || isComponentGroup || (inPoseMode && node.slot)) {
          const collarMat = this.trackMat(
            new THREE.MeshBasicMaterial({
              color: isLocked
                ? 0xf87171
                : isSelected
                  ? 0xfdba74
                  : isMultiSelected
                    ? 0x38bdf8
                    : isComponentGroup
                      ? 0xfbbf24
                      : isHovered
                        ? 0xa5f3fc
                        : 0x7dd3fc,
              transparent: true,
              opacity: isSelected || isMultiSelected || isHovered ? 0.96 : 0.58,
              depthTest: false,
            }),
          );
          const collar = new THREE.Mesh(this.socketCollarGeom, collarMat);
          collar.renderOrder = 906;
          collar.position.copy(wp);
          collar.quaternion.copy(wq);
          this.group.add(collar);
          this.liveNodeAnchors.push({
            obj: collar,
            nodeId: node.nodeId,
            worldPos: wp.clone(),
            baseScale: isSelected || isMultiSelected ? 1.2 : 1.0,
            copyQuat: true,
          });
        }
      }

      // Interactive orthogonal local X/Y/Z rotation rings with arrowheads on the active selected joint
      if (isSelected && !isLocked && !isRoot) {
        const ringHolder = new THREE.Group();
        ringHolder.position.copy(wp);
        ringHolder.quaternion.copy(wq);

        const activeOrHovered = state.activeRingAxis ?? state.hoveredRingAxis ?? null;
        this.buildAxisRing(ringHolder, 'x', 0xf87171, state.instanceId, node.nodeId, node.name, activeOrHovered === 'x');
        this.buildAxisRing(ringHolder, 'y', 0x4ade80, state.instanceId, node.nodeId, node.name, activeOrHovered === 'y');
        this.buildAxisRing(ringHolder, 'z', 0x60a5fa, state.instanceId, node.nodeId, node.name, activeOrHovered === 'z');

        this.group.add(ringHolder);
        this.liveNodeAnchors.push({
          obj: ringHolder,
          nodeId: node.nodeId,
          worldPos: wp.clone(),
          baseScale: 1.0,
          copyQuat: true,
        });
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
        new THREE.MeshStandardMaterial({
          color: isSelectedIk ? 0xfacc15 : 0x4ade80,
          emissive: isSelectedIk ? 0xfacc15 : 0x4ade80,
          emissiveIntensity: 0.45,
          flatShading: true,
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
      this.ikScalables.push({ obj: mesh, worldPos: worldTarget.clone(), baseScale: isSelectedIk ? 1.25 : 1.0 });

      const auraMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: isSelectedIk ? 0xfef08a : 0x86efac,
          transparent: true,
          opacity: 0.78,
          depthTest: false,
        }),
      );
      const aura = new THREE.Mesh(this.ikAuraGeom, auraMat);
      aura.rotation.x = Math.PI / 2;
      aura.renderOrder = 918;
      aura.position.copy(worldTarget);
      this.group.add(aura);
      this.ikScalables.push({ obj: aura, worldPos: worldTarget.clone(), baseScale: 1.0 });
    }
  }

  /**
   * Synchronizes bone prism lengths/orientations and socket/ring transforms live during drags
   * with zero geometry/material allocations.
   */
  updateLivePositions(adapter: AnyCharacterAdapter | undefined, camera: THREE.Camera): void {
    if (!adapter) {
      this.updateScales(camera);
      return;
    }
    adapter.rootGroup.updateMatrixWorld(true);
    const getNodeObj =
      'getNodeObject' in adapter && typeof adapter.getNodeObject === 'function'
        ? (id: string) => adapter.getNodeObject(id)
        : () => undefined;

    for (const anchor of this.liveNodeAnchors) {
      const obj = getNodeObj(anchor.nodeId);
      if (!obj) continue;
      obj.getWorldPosition(this.tmpParentPos);
      anchor.obj.position.copy(this.tmpParentPos);
      anchor.worldPos.copy(this.tmpParentPos);
      if (anchor.copyQuat) {
        obj.getWorldQuaternion(this.tmpQuat);
        anchor.obj.quaternion.copy(this.tmpQuat);
      }
    }

    for (const link of this.liveBoneLinks) {
      const pObj = getNodeObj(link.parentNodeId);
      const cObj = getNodeObj(link.childNodeId);
      if (!pObj || !cObj) continue;
      pObj.getWorldPosition(this.tmpParentPos);
      cObj.getWorldPosition(this.tmpChildPos);
      const len = this.tmpParentPos.distanceTo(this.tmpChildPos);
      if (len >= 0.02) {
        link.mesh.position.copy(this.tmpParentPos);
        link.mesh.lookAt(this.tmpChildPos);
        link.mesh.scale.set(1, 1, len);
      }
    }

    this.updateScales(camera);
  }

  /**
   * Keeps sockets, collars, and rotation rings legible across close-up hand zooms and wide stage shots.
   */
  updateScales(camera: THREE.Camera): void {
    const camPos = camera.position;
    for (const item of this.liveNodeAnchors) {
      const dist = camPos.distanceTo(item.worldPos);
      const factor = THREE.MathUtils.clamp(dist / 7.5, 0.28, 2.2) * item.baseScale;
      item.obj.scale.setScalar(factor);
    }
    for (const item of this.ikScalables) {
      const dist = camPos.distanceTo(item.worldPos);
      const factor = THREE.MathUtils.clamp(dist / 7.5, 0.45, 2.2) * item.baseScale;
      item.obj.scale.setScalar(factor);
    }
  }

  dispose(): void {
    this.clear();
    this.socketCoreGeom.dispose();
    this.socketCollarGeom.dispose();
    this.rootRingGeom.dispose();
    this.bonePrismGeom.dispose();
    this.axisRingGeom.dispose();
    this.axisRingHitGeom.dispose();
    this.axisArrowGeom.dispose();
    this.ikDiamondGeom.dispose();
    this.ikAuraGeom.dispose();
  }
}

function ringGroupScale(group: THREE.Group, s: number): void {
  group.scale.setScalar(s);
}
