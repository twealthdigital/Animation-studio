import type { AssetRecord, ProjectData } from '../core/types';
import {
  STORE_ASSETS,
  STORE_BLOBS,
  STORE_PROJECTS,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
} from './Database';

export async function saveProject(project: ProjectData): Promise<void> {
  const updated: ProjectData = {
    ...project,
    updatedAt: Date.now(),
  };
  await idbPut(STORE_PROJECTS, updated);
}

export async function loadProject(projectId: string): Promise<ProjectData | undefined> {
  return idbGet<ProjectData>(STORE_PROJECTS, projectId);
}

export async function listProjects(): Promise<ProjectData[]> {
  const all = await idbGetAll<ProjectData>(STORE_PROJECTS);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(projectId: string): Promise<void> {
  await idbDelete(STORE_PROJECTS, projectId);
}

export async function saveAsset(record: AssetRecord, binaryData?: ArrayBuffer): Promise<void> {
  await idbPut(STORE_ASSETS, record);
  if (binaryData) {
    await idbPut(STORE_BLOBS, binaryData, record.id);
  }
}

export async function listAssets(): Promise<AssetRecord[]> {
  const all = await idbGetAll<AssetRecord>(STORE_ASSETS);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadAssetBinary(assetId: string): Promise<ArrayBuffer | undefined> {
  return idbGet<ArrayBuffer>(STORE_BLOBS, assetId);
}

export async function deleteAsset(assetId: string): Promise<void> {
  await idbDelete(STORE_ASSETS, assetId);
  await idbDelete(STORE_BLOBS, assetId);
}
