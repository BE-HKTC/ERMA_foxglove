// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  SavedLayout,
  useWorkspaceActions,
} from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";

export type LayoutsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function LayoutsDialog({ open, onClose }: LayoutsDialogProps): JSX.Element {
  const { t } = useTranslation("appBar");
  const { layoutActions } = useWorkspaceActions();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);

  useEffect(() => {
    if (open) {
      layoutActions
        .fetchSavedLayouts()
        .then(setLayouts)
        .catch(() => setLayouts([]));
    }
  }, [open, layoutActions]);

  const refresh = async () => {
    const items = await layoutActions.fetchSavedLayouts().catch(() => []);
    setLayouts(items);
  };

  const handleSave = async () => {
    await layoutActions.save(name, target);
    await refresh();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("layouts")}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField
            label={t("layoutName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
          />
          <TextField
            label={t("layoutTarget")}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            fullWidth
          />
          <Button variant="contained" onClick={handleSave} disabled={!name}>
            {t("saveLayout")}
          </Button>
          <Button onClick={() => layoutActions.importFromFile()}>
            {t("importLayoutFromFile")}
          </Button>
          <Button onClick={() => layoutActions.exportToFile()}>
            {t("exportLayoutToFile")}
          </Button>
          <List dense>
            {layouts.map((layout) => (
              <ListItem
                key={layout.name}
                disableGutters
                onClick={() => {
                  setName(layout.name);
                  setTarget(layout.target ?? "");
                }}
                secondaryAction={
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      onClick={() => layoutActions.openSaved(layout.name, layout.target)}
                    >
                      {t("open")}
                    </Button>
                    <Button
                      size="small"
                      onClick={async () => {
                        await layoutActions.save(layout.name, target);
                        await refresh();
                      }}
                    >
                      {t("updateLayout")}
                    </Button>
                    <Button
                      size="small"
                      onClick={async () => {
                        await layoutActions.delete(layout.name);
                        await refresh();
                      }}
                    >
                      {t("deleteLayout")}
                    </Button>
                  </Stack>
                }
              >
                <ListItemText
                  primary={layout.name}
                  secondary={
                    <>
                      {layout.target && (
                        <>
                          {t("layoutTarget")}: {layout.target}
                          <br />
                        </>
                      )}
                      {t("created")}: {new Date(layout.createdAt).toLocaleString()}
                      <br />
                      {t("updated")}: {new Date(layout.updatedAt).toLocaleString()}
                    </>
                  }
                  secondaryTypographyProps={{ component: "div" }}
                />
              </ListItem>
            ))}
          </List>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

