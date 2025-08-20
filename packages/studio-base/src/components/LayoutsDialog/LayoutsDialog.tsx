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

import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";

export type LayoutsDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function LayoutsDialog({ open, onClose }: LayoutsDialogProps): JSX.Element {
  const { t } = useTranslation("appBar");
  const { layoutActions } = useWorkspaceActions();
  const [name, setName] = useState("");
  const [layouts, setLayouts] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      layoutActions
        .fetchSavedLayouts()
        .then(setLayouts)
        .catch(() => setLayouts([]));
    }
  }, [open, layoutActions]);

  const refresh = async () => {
    const names = await layoutActions.fetchSavedLayouts().catch(() => []);
    setLayouts(names);
  };

  const handleSave = async () => {
    await layoutActions.save(name);
    await refresh();
  };

  const handleShare = async () => {
    await layoutActions.share(name);
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
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={handleSave} disabled={!name}>
              {t("saveLayout")}
            </Button>
            <Button variant="outlined" onClick={handleShare} disabled={!name}>
              {t("shareLayout")}
            </Button>
          </Stack>
          <Button onClick={() => layoutActions.importFromFile()}>
            {t("importLayoutFromFile")}
          </Button>
          <Button onClick={() => layoutActions.exportToFile()}>
            {t("exportLayoutToFile")}
          </Button>
          <List dense>
            {layouts.map((layout) => (
              <ListItem
                key={layout}
                button
                onClick={() => layoutActions.openSaved(layout)}
              >
                <ListItemText primary={layout} />
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

