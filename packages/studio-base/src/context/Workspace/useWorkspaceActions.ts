// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Draft, produce } from "immer";
import * as _ from "lodash-es";
import { Dispatch, SetStateAction, useCallback, useMemo } from "react";
import { useMountedState } from "react-use";
import { useSnackbar } from "notistack";
import Logger from "@foxglove/log";

import { useGuaranteedContext } from "@foxglove/hooks";
import { AppSettingsTab } from "@foxglove/studio-base/components/AppSettingsDialog/AppSettingsDialog";
import { DataSourceDialogItem } from "@foxglove/studio-base/components/DataSourceDialog";
import { useAnalytics } from "@foxglove/studio-base/context/AnalyticsContext";
import { useAppContext } from "@foxglove/studio-base/context/AppContext";
import {
  LayoutData,
  useCurrentLayoutActions,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import {
  IDataSourceFactory,
  usePlayerSelection,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import useCallbackWithToast from "@foxglove/studio-base/hooks/useCallbackWithToast";
import { AppEvent } from "@foxglove/studio-base/services/IAnalytics";
import { downloadTextFile } from "@foxglove/studio-base/util/download";
import clipboard from "@foxglove/studio-base/util/clipboard";
import { updateAppURLState } from "@foxglove/studio-base/util/appURLState";
import showOpenFilePicker from "@foxglove/studio-base/util/showOpenFilePicker";

import {
  LeftSidebarItemKey,
  LeftSidebarItemKeys,
  RightSidebarItemKey,
  RightSidebarItemKeys,
  WorkspaceContext,
  WorkspaceContextStore,
} from "./WorkspaceContext";
import { useOpenFile } from "./useOpenFile";

const log = Logger.getLogger(__filename);

function slugifyTarget(target?: string): string | undefined {
  if (!target) {
    return undefined;
  }
  const slug = target
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug.length > 0 ? slug : undefined;
}

function bridgeUrlForTarget(target?: string): string | undefined {
  const slug = slugifyTarget(target);
  if (!slug) {
    return undefined;
  }
  if (typeof window === "undefined" || !window.location) {
    return `/ws/${slug}`;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/${slug}`;
}

export type SavedLayout = {
  name: string;
  createdAt: string;
  updatedAt: string;
  target?: string;
  retention?: boolean;
  topics?: string[];
};

export type WorkspaceActions = {
  dialogActions: {
    dataSource: {
      close: () => void;
      open: (item: DataSourceDialogItem, dataSource?: IDataSourceFactory) => void;
    };
    openFile: {
      open: () => Promise<void>;
    };
    preferences: {
      close: () => void;
      open: (initialTab?: AppSettingsTab) => void;
    };
    layouts: {
      open: () => void;
      close: () => void;
    };
  };

  featureTourActions: {
    startTour: (tour: string) => void;
    finishTour: (tour: string) => void;
  };

  openPanelSettings: () => void;

  playbackControlActions: {
    setRepeat: Dispatch<SetStateAction<boolean>>;
  };

  sidebarActions: {
    left: {
      selectItem: (item: undefined | LeftSidebarItemKey) => void;
      setOpen: Dispatch<SetStateAction<boolean>>;
      setSize: (size: undefined | number) => void;
    };
    right: {
      selectItem: (item: undefined | RightSidebarItemKey) => void;
      setOpen: Dispatch<SetStateAction<boolean>>;
      setSize: (size: undefined | number) => void;
    };
  };

  layoutActions: {
    // Open a dialog for the user to select a layout file to import
    // This will replace the current layout with the imported layout
    importFromFile: () => void;
    // Export the current layout to a file
    // This will perform a browser download of the current layout to a file
    exportToFile: () => void;
    // Upload the current layout to the server and copy a shareable URL
    share: (name?: string, target?: string, retentionEnabled?: boolean, topicsCsv?: string) => void;
    // Save the current layout to the server without copying a URL
    save: (name?: string, target?: string, retentionEnabled?: boolean, topicsCsv?: string) => Promise<void>;
    // Fetch saved layout metadata from the server
    fetchSavedLayouts: () => Promise<SavedLayout[]>;
    // Open a saved layout in a new browser tab
    openSaved: (layout: SavedLayout) => void;

    // Delete a saved layout on the server
    delete: (name: string) => Promise<void>;
  };
};

function setterValue<T>(action: SetStateAction<T>, value: T): T {
  if (action instanceof Function) {
    return action(value);
  }

  return action;
}

/**
 * Provides various actions to manipulate the workspace state.
 */
export function useWorkspaceActions(): WorkspaceActions {
  const { setState } = useGuaranteedContext(WorkspaceContext);

  const { availableSources } = usePlayerSelection();

  const analytics = useAnalytics();
  const appContext = useAppContext();
  const { enqueueSnackbar } = useSnackbar();

  const isMounted = useMountedState();

  const { getCurrentLayoutState, setCurrentLayout } = useCurrentLayoutActions();

  const openFile = useOpenFile(availableSources);

  const set = useCallback(
    (setter: (draft: Draft<WorkspaceContextStore>) => void) => {
      setState(produce<WorkspaceContextStore>(setter));
    },
    [setState],
  );

  const importLayoutFromFile = useCallbackWithToast(async () => {
    log.debug("importLayoutFromFile: opening file picker");
    const fileHandles = await showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [
        {
          description: "JSON Files",
          accept: {
            "application/json": [".json"],
          },
        },
      ],
    });
    if (!isMounted()) {
      return;
    }

    const [fileHandle] = fileHandles;
    if (!fileHandle) {
      return;
    }

    log.debug("importLayoutFromFile: file selected", fileHandle.name);

    const file = await fileHandle.getFile();
    const content = await file.text();

    if (!isMounted()) {
      return;
    }

    let parsedState: unknown;
    try {
      parsedState = JSON.parse(content);
    } catch (err) {
      throw new Error(`${file.name} is not a valid layout: ${err.message}`);
    }

    if (typeof parsedState !== "object" || !parsedState) {
      throw new Error(`${file.name} is not a valid layout`);
    }

    const data = parsedState as LayoutData;

    // If there's an app context handler for this we let it take over from here
    if (appContext.importLayoutFile) {
      log.debug("importLayoutFromFile: delegating to app context");
      await appContext.importLayoutFile(file.name, data);
      return;
    }

    log.debug("importLayoutFromFile: applying layout from file");
    setCurrentLayout({ data });

    void analytics.logEvent(AppEvent.LAYOUT_IMPORT);
  }, [analytics, appContext, isMounted, setCurrentLayout]);

  const exportLayoutToFile = useCallback(() => {
    // Use a stable getter to fetch the current layout to avoid thrashing the
    // dependencies array for our hook.
    const layoutData = getCurrentLayoutState().selectedLayout?.data;
    if (!layoutData) {
      return;
    }

    const name = getCurrentLayoutState().selectedLayout?.name ?? "foxglove-layout";
    const content = JSON.stringify(layoutData, undefined, 2) ?? "";
    log.debug("exportLayoutToFile: exporting layout", name);
    downloadTextFile(content, `${name}.json`);
    void analytics.logEvent(AppEvent.LAYOUT_EXPORT);
  }, [analytics, getCurrentLayoutState]);


  const shareLayout = useCallbackWithToast(
    async (
      rawName?: string,
      targetName?: string,
      retentionEnabled?: boolean,
      topicsCsv?: string,
    ) => {

    const layoutData = getCurrentLayoutState().selectedLayout?.data;
    if (!layoutData) {
      return;
    }

    const baseName = rawName ?? getCurrentLayoutState().selectedLayout?.name ?? `layout-${Date.now()}`;
    const safeName = baseName.replace(/[^a-z0-9._-]/gi, "_");
    log.debug("shareLayout: uploading", safeName);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (targetName != undefined) {
      headers["X-Layout-Target"] = targetName.trim();
    }
    if (retentionEnabled != undefined) {
      headers["X-Layout-Retention"] = String(Boolean(retentionEnabled));
    }
    if (topicsCsv != undefined) {
      headers["X-Layout-Topics"] = topicsCsv;
    }

    const response = await fetch(`/layouts/${safeName}.json`, {
      method: "PUT",
      headers,
      body: JSON.stringify(layoutData),
    });
    if (!response.ok) {
      log.error("shareLayout: upload failed", response.status, response.statusText);
      throw new Error(`Failed to save layout: ${response.statusText}`);
    }

    const shareUrl = updateAppURLState(new URL(window.location.href), {
      layout: safeName,
    });
    await clipboard.copy(shareUrl.href);
    log.debug("shareLayout: copied URL", shareUrl.href);
    enqueueSnackbar("Copied layout URL to clipboard", { variant: "success" });
    void analytics.logEvent(AppEvent.LAYOUT_SHARE);
    },
    [analytics, enqueueSnackbar, getCurrentLayoutState],
  );

  const saveLayout = useCallback(async (rawName?: string, targetName?: string, retentionEnabled?: boolean, topicsCsv?: string) => {
    const layoutData = getCurrentLayoutState().selectedLayout?.data;
    if (!layoutData) {
      return;
    }

    const baseName = rawName ?? prompt("Enter layout name");
    if (!baseName) {
      return;
    }

    const safeName = baseName.replace(/[^a-z0-9._-]/gi, "_");
    log.debug("saveLayout: saving", safeName);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (targetName != undefined) {
      headers["X-Layout-Target"] = targetName.trim();
    }
    if (retentionEnabled != undefined) {
      headers["X-Layout-Retention"] = String(Boolean(retentionEnabled));
    }
    if (topicsCsv != undefined) {
      headers["X-Layout-Topics"] = topicsCsv;
    }

    const response = await fetch(`/layouts/${safeName}.json`, {
      method: "PUT",
      headers,

      body: JSON.stringify(layoutData),
    });
    if (!response.ok) {
      log.error("saveLayout: upload failed", response.status, response.statusText);
      throw new Error(`Failed to save layout: ${response.statusText}`);
    }
    enqueueSnackbar("Layout saved", { variant: "success" });
  }, [enqueueSnackbar, getCurrentLayoutState]);

  const fetchSavedLayouts = useCallback(async (): Promise<SavedLayout[]> => {
    log.debug("fetchSavedLayouts: requesting index");
    const response = await fetch("/layouts/index.json");
    if (!response.ok) {
      log.error("fetchSavedLayouts: request failed", response.status, response.statusText);
      return [];
    }
    const layouts = (await response.json()) as SavedLayout[];
    log.debug("fetchSavedLayouts: received", layouts);
    return layouts;
  }, []);

  const deleteLayout = useCallback(
    async (name: string) => {
      log.debug("deleteLayout: deleting", name);
      const response = await fetch(`/layouts/${name}.json`, { method: "DELETE" });
      if (!response.ok) {
        log.error("deleteLayout: failed", response.status, response.statusText);
        throw new Error(`Failed to delete layout: ${response.statusText}`);
      }
      enqueueSnackbar("Layout deleted", { variant: "success" });
    },
    [enqueueSnackbar],
  );

  const openSavedLayout = useCallback((layout: SavedLayout) => {
    const { name, target, retention } = layout;
    log.debug("openSavedLayout: opening", name, target, retention);
    const bridgeUrl = retention ? bridgeUrlForTarget(target) : undefined;
    const connectionUrl = bridgeUrl ?? target;
    const url = updateAppURLState(new URL(window.location.href), {
      layout: name,
      ...(connectionUrl
        ? {
            ds: "foxglove-websocket",
            dsParams: { url: connectionUrl },
          }
        : {}),
    });

    window.open(url.href, "_blank");
  }, []);

  return useMemo(() => {
    return {
      dialogActions: {
        dataSource: {
          close: () => {
            set((draft) => {
              draft.dialogs.dataSource = {
                activeDataSource: undefined,
                item: undefined,
                open: false,
              };
            });
          },

          open: (
            selectedDataSourceDialogItem: DataSourceDialogItem,
            dataSource?: IDataSourceFactory,
          ) => {
            set((draft) => {
              // This cast is necessary to keep typescript from complaining about type depth.
              (draft as WorkspaceContextStore).dialogs.dataSource.activeDataSource = dataSource;
              draft.dialogs.dataSource.item = selectedDataSourceDialogItem;
              draft.dialogs.dataSource.open = true;
            });
          },
        },

        openFile: {
          open: openFile,
        },

        preferences: {
          close: () => {
            set((draft) => {
              draft.dialogs.preferences = { open: false, initialTab: undefined };
            });
          },
          open: (initialTab?: AppSettingsTab) => {
            set((draft) => {
              draft.dialogs.preferences = { open: true, initialTab };
            });
          },
        },

        layouts: {
          open: () => {
            set((draft) => {
              draft.dialogs.layouts.open = true;
            });
          },
          close: () => {
            set((draft) => {
              draft.dialogs.layouts.open = false;
            });
          },
        },
      },

      featureTourActions: {
        startTour: (tour: string) => {
          set((draft) => {
            draft.featureTours.active = tour;
          });
        },
        finishTour: (tour: string) => {
          set((draft) => {
            draft.featureTours.active = undefined;
            draft.featureTours.shown = _.union(draft.featureTours.shown, [tour]);
          });
        },
      },

      openPanelSettings: () => {
        set((draft) => {
          draft.sidebars.left.item = "panel-settings";
          draft.sidebars.left.open = true;
        });
      },

      playbackControlActions: {
        setRepeat: (setter: SetStateAction<boolean>) => {
          set((draft) => {
            const repeat = setterValue(setter, draft.playbackControls.repeat);
            draft.playbackControls.repeat = repeat;
          });
        },
      },

      sidebarActions: {
        left: {
          selectItem: (selectedLeftSidebarItem: undefined | LeftSidebarItemKey) => {
            set((draft) => {
              draft.sidebars.left.item = selectedLeftSidebarItem;
              draft.sidebars.left.open = selectedLeftSidebarItem != undefined;
            });
          },

          setOpen: (setter: SetStateAction<boolean>) => {
            set((draft) => {
              const leftSidebarOpen = setterValue(setter, draft.sidebars.left.open);
              if (leftSidebarOpen) {
                const oldItem = LeftSidebarItemKeys.find(
                  (item) => item === draft.sidebars.left.item,
                );
                draft.sidebars.left.open = leftSidebarOpen;
                draft.sidebars.left.item = oldItem ?? "panel-settings";
              } else {
                draft.sidebars.left.open = false;
              }
            });
          },

          setSize: (leftSidebarSize: undefined | number) => {
            set((draft) => {
              draft.sidebars.left.size = leftSidebarSize;
            });
          },
        },
        right: {
          selectItem: (selectedRightSidebarItem: undefined | RightSidebarItemKey) => {
            set((draft) => {
              draft.sidebars.right.item = selectedRightSidebarItem;
              draft.sidebars.right.open = selectedRightSidebarItem != undefined;
            });
          },

          setOpen: (setter: SetStateAction<boolean>) => {
            set((draft) => {
              const rightSidebarOpen = setterValue(setter, draft.sidebars.right.open);
              const oldItem = RightSidebarItemKeys.find(
                (item) => item === draft.sidebars.right.item,
              );
              if (rightSidebarOpen) {
                draft.sidebars.right.open = rightSidebarOpen;
                draft.sidebars.right.item = oldItem ?? "variables";
              } else {
                draft.sidebars.right.open = false;
              }
            });
          },

          setSize: (rightSidebarSize: undefined | number) => {
            set((draft) => {
              draft.sidebars.right.size = rightSidebarSize;
            });
          },
        },
      },

      layoutActions: {
        importFromFile: importLayoutFromFile,
        exportToFile: exportLayoutToFile,
        share: shareLayout,
        save: saveLayout,
        fetchSavedLayouts: fetchSavedLayouts,
        openSaved: openSavedLayout,
        delete: deleteLayout,
      },
    };
  }, [
    exportLayoutToFile,
    importLayoutFromFile,
    shareLayout,
    saveLayout,
    fetchSavedLayouts,
    openSavedLayout,
    deleteLayout,
    openFile,
    set,
  ]);
}
