// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2024 Joshua Newans
//   Copyright 2022 Ryan Govostes
//   Licensed under the MIT license (see LICENSE file in the original project)

import { Button, LinearProgress, Stack } from "@mui/material";

import { Joy } from "@foxglove/studio-base/panels/Joystick/types";

type Props = {
  joy: Joy | undefined;
};

export function SimpleButtonView({ joy }: Props) {
  const buttons = (joy?.buttons ?? []).map((value, index) => (
    <Button
      key={index}
      variant={value > 0 ? "contained" : "outlined"}
      size="large"
      color={value > 0 ? "error" : "primary"}
    >
      {index}
    </Button>
  ));

  const axes = (joy?.axes ?? []).map((value, index) => (
    <LinearProgress
      key={index}
      variant="determinate"
      value={value * 50 + 50}
      sx={{ transition: "none" }}
    />
  ));

  return (
    <Stack gap={1} maxWidth={320}>
      {buttons}
      {axes}
    </Stack>
  );
}
