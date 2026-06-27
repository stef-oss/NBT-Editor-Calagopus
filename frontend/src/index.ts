import { faFileCode } from '@fortawesome/free-solid-svg-icons';
import { createElement, type FC, useEffect } from 'react';
import { createSearchParams, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Extension, ExtensionContext } from 'shared';
import { useServerStore } from '@/stores/server.ts';
import NbtEditorPage from './NbtEditorPage.tsx';

type DirectoryEntry = {
  name: string;
  directory?: boolean;
};

type FileManagerContext = {
  browsingDirectory?: string;
};

type FileOpenContext = {
  server: { uuidShort: string };
  fileManagerContext: FileManagerContext;
  navigate: (to: string) => void;
};

type FilesRegistry = {
  fileIconHandlers?: Array<(file: DirectoryEntry, fileManagerContext: FileManagerContext) => unknown>;
  fileOpenHandlers?: Array<
    (
      file: DirectoryEntry,
      fileManagerContext: FileManagerContext,
    ) =>
      | {
          openable: true;
          handleOpen: (ctx: FileOpenContext) => void;
        }
      | null
      | undefined
  >;
  [key: string]: unknown;
};

type ServerRoute = {
  path: string;
  element: FC;
};

const isNbtFile = (file: DirectoryEntry) => {
  if (file.directory) return false;
  const name = file.name.toLowerCase();
  return name.endsWith('.dat') || name.endsWith('.nbt');
};

const isNbtFileName = (name: string) => {
  const lower = name.toLowerCase();
  return lower.endsWith('.dat') || lower.endsWith('.nbt');
};

const joinPath = (directory: string | undefined, file: string) => {
  const normalizedFile = file.replace(/\\/g, '/');
  if (normalizedFile.startsWith('/')) return normalizedFile.replace(/\/+/g, '/');
  const base = (directory || '/').replace(/\\/g, '/').replace(/\/+$/, '');
  return `${base || ''}/${normalizedFile}`.replace(/\/+/g, '/').replace(/^\/?/, '/');
};

const fileNamePattern = /(?:^|[\s/\\])([^/\\\s]+?\.(?:dat|nbt))(?=\s|$)/i;

const findNbtFileName = (target: HTMLElement | null) => {
  const explicit = target?.closest?.('[data-file-name]')?.getAttribute('data-file-name');
  if (explicit && isNbtFileName(explicit)) return explicit;

  const titled = target?.closest?.('[title], .pd-files-row__name-inner')?.getAttribute('title');
  if (titled && isNbtFileName(titled)) return titled.split(/[\\/]/).pop() ?? titled;

  const label = target?.closest?.('.pd-files-row__label, [data-file-label], [data-name]') as HTMLElement | null;
  const labelName = label?.getAttribute('data-file-label') ?? label?.getAttribute('data-name') ?? label?.textContent?.trim();
  if (labelName && isNbtFileName(labelName)) return labelName;

  const row = target?.closest?.('.pd-files-row, tr, [role="row"], [data-file-row], [data-pd-file-row]') as HTMLElement | null;
  if (row?.querySelector('th')) return null;

  const sources = [
    target?.closest?.('.pd-files-row__name')?.textContent,
    target?.closest?.('.pd-files-row__name-inner')?.textContent,
    row?.querySelector?.('.pd-files-row__label')?.textContent,
    row?.getAttribute?.('data-file-name'),
    row?.getAttribute?.('data-name'),
    row?.textContent,
    target?.textContent,
  ];

  for (const source of sources) {
    const match = source?.match(fileNamePattern);
    if (match?.[1] && isNbtFileName(match[1])) return match[1];
  }

  return null;
};

function NbtFileEditorRedirect({ fallback: Fallback }: { fallback: FC }) {
  const { action } = useParams<'action'>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const file = searchParams.get('file')?.trim() ?? '';
  const directory = searchParams.get('directory')?.trim() || '/';
  const serverId = location.pathname.match(/\/server\/([^/]+)/)?.[1] ?? '';
  const isEditRoute = action === 'edit' || /\/files\/edit(?:\/|$)/.test(location.pathname);

  if (serverId && isEditRoute && file && isNbtFileName(file)) {
    const filePath = joinPath(directory, file);
    return createElement(Navigate, {
      to: `/server/${serverId}/nbt-editor?${createSearchParams({ file: filePath })}`,
      replace: true,
    });
  }

  return createElement(Fallback);
}

function NbtFileManagerBridge() {
  const location = useLocation();
  const navigate = useNavigate();
  const server = useServerStore((state) => state.server);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (!/\/server\/[^/]+\/files(?:\/|$)/.test(location.pathname) || /\/files\/(edit|new|image|audio|diff)(?:\/|$)/.test(location.pathname)) {
      return undefined;
    }

    const openFromRow = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('button, input, label, select, textarea, [role="button"], .pd-files-row__actions-cell, .pd-files-row__checkbox')) {
        return;
      }

      const fileName = findNbtFileName(target);
      if (!fileName || !server?.uuidShort) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const filePath = joinPath(searchParams.get('directory') ?? '/', fileName);
      navigate(`/server/${server.uuidShort}/nbt-editor?${createSearchParams({ file: filePath })}`);
    };

    document.addEventListener('click', openFromRow, true);
    document.addEventListener('dblclick', openFromRow, true);
    return () => {
      document.removeEventListener('click', openFromRow, true);
      document.removeEventListener('dblclick', openFromRow, true);
    };
  }, [location.pathname, navigate, searchParams, server?.uuidShort]);

  return null;
}

class CalStefNbtEditorExtension extends Extension {
  public cardConfigurationPage: FC | null = null;
  public cardComponent: FC | null = null;

  public initialize(ctx: ExtensionContext): void {
    ctx.extensionRegistry.pages.server.prependComponent(NbtFileManagerBridge);

    const filesRegistry = ctx.extensionRegistry.pages.server.files as FilesRegistry | undefined;
    filesRegistry?.fileIconHandlers?.unshift((file) => (isNbtFile(file) ? faFileCode : null));

    const openHandler: NonNullable<FilesRegistry['fileOpenHandlers']>[number] = (file) => {
      if (!isNbtFile(file)) return null;

      return {
        openable: true,
        handleOpen: ({ server, fileManagerContext, navigate }) => {
          const filePath = joinPath(fileManagerContext.browsingDirectory, file.name);
          navigate(`/server/${server.uuidShort}/nbt-editor?${createSearchParams({ file: filePath })}`);
        },
      };
    };

    for (const handlerKey of ['fileOpenHandlers', 'fileOpenModeHandlers', 'openHandlers']) {
      const handlers = filesRegistry?.[handlerKey];
      if (Array.isArray(handlers)) {
        handlers.unshift(openHandler);
      }
    }

    ctx.extensionRegistry.enterRoutes((routes) => {
      routes.addServerRouteInterceptor((serverRoutes) => {
        for (const route of serverRoutes as ServerRoute[]) {
          if (!route.path.startsWith('/files/')) continue;
          const Original = route.element;
          route.element = () => createElement(NbtFileEditorRedirect, { fallback: Original });
        }
      });
    });

    ctx.extensionRegistry.routes.addServerRoute({
      name: undefined,
      path: '/nbt-editor',
      exact: true,
      element: NbtEditorPage,
      permission: 'nbt-editor.view',
    });
  }
}

export default new CalStefNbtEditorExtension();
