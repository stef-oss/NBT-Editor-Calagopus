import { axiosInstance } from '@/api/axios.ts';

export type NbtEdition = 'java' | 'bedrock';
export type NbtCompression = 'none' | 'gzip' | 'zlib';

export interface NbtEntry {
  name: string;
  node: NbtNode;
}

export interface NbtNode {
  tagType: string;
  value:
    | { kind: 'byte'; value: number }
    | { kind: 'short'; value: number }
    | { kind: 'int'; value: number }
    | { kind: 'long'; value: number }
    | { kind: 'float'; value: number }
    | { kind: 'double'; value: number }
    | { kind: 'string'; value: string }
    | { kind: 'byteArray'; length: number; preview: number[] }
    | { kind: 'intArray'; length: number; preview: number[] }
    | { kind: 'longArray'; length: number; preview: number[] }
    | { kind: 'list'; elementType: string; length: number; items: NbtNode[] }
    | { kind: 'compound'; entries: NbtEntry[] };
}

export interface ParsedNbt {
  edition: NbtEdition;
  compression: NbtCompression;
  rootName: string;
  root: NbtNode;
  bedrockHeaderVersion?: number | null;
  rootless: boolean;
}

export async function readNbtFile(
  serverUuid: string,
  file: string,
  edition: 'auto' | NbtEdition,
): Promise<{ file: string; parsed: ParsedNbt }> {
  const { data } = await axiosInstance.get(`/api/client/servers/${serverUuid}/nbt-editor/read`, {
    params: { file, edition },
  });

  return data;
}

export async function saveNbtFile(
  serverUuid: string,
  file: string,
  parsed: ParsedNbt,
): Promise<{ file: string }> {
  const { data } = await axiosInstance.post(`/api/client/servers/${serverUuid}/nbt-editor/save`, {
    file,
    parsed,
  });

  return data;
}
