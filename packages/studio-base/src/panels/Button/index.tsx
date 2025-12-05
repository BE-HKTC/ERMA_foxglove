// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2019-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { Button, Tooltip, Typography } from "@mui/material";
import { memo, useEffect, useMemo } from "react";
import { makeStyles } from "tss-react/mui";
import { useDebounce } from "use-debounce";

import { MessageDefinition } from "@foxglove/message-definition";
import CommonRosTypes from "@foxglove/rosmsg-msgs-common";
import { Immutable } from "@foxglove/studio";
import { useDataSourceInfo } from "@foxglove/studio-base/PanelAPI";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Panel from "@foxglove/studio-base/components/Panel";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import Stack from "@foxglove/studio-base/components/Stack";
import useCallbackWithToast from "@foxglove/studio-base/hooks/useCallbackWithToast";
import usePublisher from "@foxglove/studio-base/hooks/usePublisher";
import { PlayerCapabilities } from "@foxglove/studio-base/players/types";
import { useDefaultPanelTitle } from "@foxglove/studio-base/providers/PanelStateContextProvider";
import { SaveConfig } from "@foxglove/studio-base/types/panels";

import { defaultConfig, useButtonPanelSettings } from "./settings";
import { ButtonConfig } from "./types";

type Props = {
  config: ButtonConfig;
  saveConfig: SaveConfig<ButtonConfig>;
};

const useStyles = makeStyles<{ buttonColor?: string }>()((theme, { buttonColor }) => {
  const augmentedButtonColor = buttonColor
    ? theme.palette.augmentColor({
        color: { main: buttonColor },
      })
    : undefined;

  return {
    button: {
      backgroundColor: augmentedButtonColor?.main,
      color: augmentedButtonColor?.contrastText,

      "&:hover": {
        backgroundColor: augmentedButtonColor?.dark,
      },
    },
  };
});

function parseInput(value: string): { error?: string; parsedObject?: unknown } {
  let parsedObject;
  let error = undefined;
  try {
    const parsedAny: unknown = JSON.parse(value);
    if (Array.isArray(parsedAny)) {
      error = "Message content must be an object, not an array";
    } else if (parsedAny == null /* eslint-disable-line no-restricted-syntax */) {
      error = "Message content must be an object, not null";
    } else if (typeof parsedAny !== "object") {
      error = `Message content must be an object, not ‘${typeof parsedAny}’`;
    } else {
      parsedObject = parsedAny;
    }
  } catch (e) {
    error = value.length !== 0 ? (e as Error).message : "Enter valid message content as JSON";
  }
  return { error, parsedObject };
}

function selectDataSourceProfile(ctx: MessagePipelineContext) {
  return ctx.playerState.profile;
}

function ButtonPanel(props: Props) {
  const { saveConfig, config } = props;
  const { topics, datatypes: dataSourceDatatypes, capabilities } = useDataSourceInfo();
  const { classes } = useStyles({ buttonColor: config.buttonColor });
  const [debouncedTopicName] = useDebounce(config.topicName ?? "", 500);
  const dataSourceProfile = useMessagePipeline(selectDataSourceProfile);

  const datatypes = useMemo(() => {
    // Add common ROS datatypes, depending on the data source profile.
    const commonTypes: Record<string, MessageDefinition> | undefined = {
      ros1: CommonRosTypes.ros1,
      ros2: CommonRosTypes.ros2galactic,
    }[dataSourceProfile ?? ""];

    if (commonTypes == undefined) {
      return dataSourceDatatypes;
    }

    // dataSourceDatatypes is added after commonTypes to take precedence (override) any commonTypes
    // of the same name
    return new Map<string, Immutable<MessageDefinition>>([
      ...Object.entries(commonTypes),
      ...dataSourceDatatypes,
    ]);
  }, [dataSourceProfile, dataSourceDatatypes]);

  const publish = usePublisher({
    name: "Button",
    topic: debouncedTopicName,
    schemaName: config.datatype,
    datatypes,
  });

  const { error, parsedObject } = useMemo(() => parseInput(config.value ?? ""), [config.value]);

  useButtonPanelSettings(config, saveConfig, topics, datatypes);

  const onPublishClicked = useCallbackWithToast(() => {
    if (config.topicName != undefined && parsedObject != undefined) {
      publish(parsedObject as Record<string, unknown>);
    } else {
      throw new Error(`called publish() when input was invalid`);
    }
  }, [config.topicName, parsedObject, publish]);

  const [, setDefaultPanelTitle] = useDefaultPanelTitle();

  useEffect(() => {
    if (config.topicName != undefined && config.topicName.length > 0) {
      setDefaultPanelTitle(`Button ${config.topicName}`);
    } else {
      setDefaultPanelTitle("Button");
    }
  }, [config.topicName, setDefaultPanelTitle]);

  const canPublish = Boolean(
    capabilities.includes(PlayerCapabilities.advertise) &&
      config.value &&
      config.topicName &&
      config.datatype &&
      parsedObject != undefined,
  );

  const statusMessage = useMemo(() => {
    if (!capabilities.includes(PlayerCapabilities.advertise)) {
      return "Connect to a data source that supports publishing";
    }
    if (!config.topicName || !config.datatype) {
      return "Configure a topic and message schema in the panel settings";
    }
    if (!config.value) {
      return "Configure a message payload in the panel settings";
    }
    return undefined;
  }, [capabilities, config.datatype, config.topicName, config.value]);

  return (
    <Stack fullHeight>
      <PanelToolbar />
      <Stack flex="auto" gap={1.5} padding={1.5} alignItems="center" justifyContent="center">
        {(error != undefined || statusMessage != undefined) && (
          <Typography variant="caption" noWrap color={error ? "error" : undefined}>
            {error ?? statusMessage}
          </Typography>
        )}
        <Tooltip placement="top" title={config.buttonTooltip}>
          <span>
            <Button
              className={classes.button}
              variant="contained"
              disabled={!canPublish}
              onClick={onPublishClicked}
            >
              {config.buttonText ?? "Send"}
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

export default Panel(
  Object.assign(memo(ButtonPanel), {
    panelType: "Button",
    defaultConfig,
  }),
);
