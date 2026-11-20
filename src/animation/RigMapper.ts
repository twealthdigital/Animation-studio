import type {
  HumanoidSlot,
  RigCompatibilityReport,
  RigNodeInfo,
  Vec3,
} from '../core/types';

const SLOT_PATTERNS: [HumanoidSlot, RegExp][] = [
  ['hips', /\b(hips?|pelvis)\b/i],
  ['spine', /\b(spine1?|waist|abdomen)\b/i],
  ['chest', /\b(chest|spine2|upperchest|torso)\b/i],
  ['neck', /\bneck\b/i],
  ['head', /\b(head|headpivot|globehead|skull)\b/i],
  ['jaw', /\b(jaw|mouth)\b/i],
  ['leftEye', /\b(left.?eye|eye.?l)\b/i],
  ['rightEye', /\b(right.?eye|eye.?r)\b/i],
  ['leftUpperArm', /\b(left.?upper.?arm|left.?shoulder|arm.?l|l.?arm|mixamorig.*leftarm)\b/i],
  ['leftForearm', /\b(left.?fore.?arm|left.?elbow|elbow.?l|forearm.?l)\b/i],
  ['leftHand', /\b(left.?hand|hand.?l|wrist.?l)\b/i],
  ['rightUpperArm', /\b(right.?upper.?arm|right.?shoulder|arm.?r|r.?arm|mixamorig.*rightarm)\b/i],
  ['rightForearm', /\b(right.?fore.?arm|right.?elbow|elbow.?r|forearm.?r)\b/i],
  ['rightHand', /\b(right.?hand|hand.?r|wrist.?r)\b/i],
  ['leftThigh', /\b(left.?thigh|left.?up.?leg|left.?hip|hip.?l|thigh.?l)\b/i],
  ['leftShin', /\b(left.?shin|left.?leg|left.?knee|knee.?l|calf.?l)\b/i],
  ['leftFoot', /\b(left.?foot|foot.?l|ankle.?l)\b/i],
  ['rightThigh', /\b(right.?thigh|right.?up.?leg|right.?hip|hip.?r|thigh.?r)\b/i],
  ['rightShin', /\b(right.?shin|right.?leg|right.?knee|knee.?r|calf.?r)\b/i],
  ['rightFoot', /\b(right.?foot|foot.?r|ankle.?r)\b/i],
];

const CORE_HUMANOID_SLOTS: HumanoidSlot[] = [
  'head',
  'leftUpperArm',
  'leftForearm',
  'rightUpperArm',
  'rightForearm',
  'leftThigh',
  'leftShin',
  'rightThigh',
  'rightShin',
];

export function autoMapHumanoidSlots(
  nodes: readonly RigNodeInfo[],
  manualOverrides?: Partial<Record<HumanoidSlot, string>>,
): Partial<Record<HumanoidSlot, string>> {
  const mapped: Partial<Record<HumanoidSlot, string>> = {};
  const usedIds = new Set<string>();

  if (manualOverrides) {
    for (const [slot, nodeId] of Object.entries(manualOverrides)) {
      if (nodeId && nodes.some((n) => n.nodeId === nodeId)) {
        mapped[slot as HumanoidSlot] = nodeId;
        usedIds.add(nodeId);
      }
    }
  }

  // First honor explicit pre-tagged slots from semantic discovery
  for (const node of nodes) {
    if (node.slot && !mapped[node.slot] && !usedIds.has(node.nodeId)) {
      mapped[node.slot] = node.nodeId;
      usedIds.add(node.nodeId);
    }
  }

  // Then pattern-match remaining node names
  for (const [slot, regex] of SLOT_PATTERNS) {
    if (mapped[slot]) continue;
    const match = nodes.find(
      (n) => !usedIds.has(n.nodeId) && regex.test(n.name.replace(/([a-z])([A-Z])/g, '$1 $2')),
    );
    if (match) {
      mapped[slot] = match.nodeId;
      usedIds.add(match.nodeId);
    }
  }

  return mapped;
}

export function buildRigCompatibilityReport(
  nodes: readonly RigNodeInfo[],
  manualOverrides?: Partial<Record<HumanoidSlot, string>>,
): RigCompatibilityReport {
  const mappedSlots = autoMapHumanoidSlots(nodes, manualOverrides);
  const mappedCount = Object.keys(mappedSlots).length;
  const missingSlots = CORE_HUMANOID_SLOTS.filter((s) => !mappedSlots[s]);

  const supportsArmIk = Boolean(
    (mappedSlots.leftUpperArm && mappedSlots.leftForearm) ||
      (mappedSlots.rightUpperArm && mappedSlots.rightForearm),
  );
  const supportsLegIk = Boolean(
    (mappedSlots.leftThigh && mappedSlots.leftShin) ||
      (mappedSlots.rightThigh && mappedSlots.rightShin),
  );
  const supportsHeadLookAt = Boolean(mappedSlots.head);

  let rigKind: RigCompatibilityReport['rigKind'] = 'rigid';
  if (mappedCount >= 8) rigKind = 'humanoid';
  else if (mappedCount >= 3) rigKind = 'partial-humanoid';
  else if (nodes.length > 1) rigKind = 'generic';

  const notes: string[] = [];
  if (rigKind === 'humanoid') {
    notes.push('Full humanoid limb & head rig mapped; bone keyframes, presets, and 2-bone IK are supported.');
  } else if (rigKind === 'partial-humanoid') {
    notes.push(`Partial humanoid rig (${mappedCount} mapped joints). Missing limbs will stay neutral or use root motion.`);
  } else if (rigKind === 'generic') {
    notes.push('Generic node hierarchy detected; select individual sub-groups to keyframe rotations directly.');
  } else {
    notes.push('Single rigid body asset; use root keyframes, motion paths, and facial/mood controls.');
  }

  return {
    rigKind,
    mappedCount,
    totalNodes: nodes.length,
    mappedSlots,
    missingSlots,
    supportsArmIk,
    supportsLegIk,
    supportsHeadLookAt,
    notes,
  };
}

/**
 * Mirrors left<->right bone rotations across the sagittal (X) axis for Pose Mirroring.
 */
export function mirrorPoseRotations(
  rotations: Record<string, Vec3>,
  mappedSlots: Partial<Record<HumanoidSlot, string>>,
): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  const pairs: [HumanoidSlot, HumanoidSlot][] = [
    ['leftUpperArm', 'rightUpperArm'],
    ['leftForearm', 'rightForearm'],
    ['leftHand', 'rightHand'],
    ['leftThigh', 'rightThigh'],
    ['leftShin', 'rightShin'],
    ['leftFoot', 'rightFoot'],
  ];

  const pairedIds = new Set<string>();
  for (const [lSlot, rSlot] of pairs) {
    const lId = mappedSlots[lSlot];
    const rId = mappedSlots[rSlot];
    if (lId && rId) {
      pairedIds.add(lId);
      pairedIds.add(rId);
      const lRot = rotations[lId] ?? { x: 0, y: 0, z: 0 };
      const rRot = rotations[rId] ?? { x: 0, y: 0, z: 0 };
      out[lId] = { x: rRot.x, y: -rRot.y, z: -rRot.z };
      out[rId] = { x: lRot.x, y: -lRot.y, z: -lRot.z };
    }
  }

  for (const [nodeId, rot] of Object.entries(rotations)) {
    if (!pairedIds.has(nodeId)) {
      out[nodeId] = { x: rot.x, y: -rot.y, z: -rot.z };
    }
  }
  return out;
}

export function blendPoses(
  poseA: Record<string, Vec3>,
  poseB: Record<string, Vec3>,
  alpha: number,
): Record<string, Vec3> {
  const t = Math.max(0, Math.min(1, alpha));
  const out: Record<string, Vec3> = {};
  const ids = new Set([...Object.keys(poseA), ...Object.keys(poseB)]);
  for (const id of ids) {
    const a = poseA[id] ?? { x: 0, y: 0, z: 0 };
    const b = poseB[id] ?? { x: 0, y: 0, z: 0 };
    out[id] = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }
  return out;
}
