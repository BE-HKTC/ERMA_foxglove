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

import { fromDate } from "@foxglove/rostime";
import CommonRosTypes from "@foxglove/rosmsg-msgs-common";
import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  SettingsTreeAction,
  Topic,
} from "@foxglove/studio";
import { FormControlLabel, FormGroup, Switch, Typography } from "@mui/material";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";

import { GamepadView } from "./components/GamepadView";
import { SimpleButtonView } from "./components/SimpleButtonView";
import kbmapping1 from "./components/kbmapping1.json";
import { useGamepad } from "./hooks/useGamepad";
import { Config, buildSettingsTree, defaultConfig, settingsActionReducer } from "./panelSettings";
import { Joy } from "./types";
import ThemeProvider from "@foxglove/studio-base/theme/ThemeProvider";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";

type KbMap = {
  button: number;
  axis: number;
  direction: number;
  value: number;
};

function buildJoyDatatypes(): { schemaName: string; datatypes?: RosDatatypes } {
  const datatypes: RosDatatypes = new Map();

  // ROS 2 only
  const joyNames = ["sensor_msgs/msg/Joy"];
  const headerNames = ["std_msgs/msg/Header"];
  const timeNames = ["builtin_interfaces/msg/Time"];

  for (const name of [...joyNames, ...headerNames, ...timeNames]) {
    const def = (CommonRosTypes.ros2galactic as Record<string, unknown>)[name];
    if (def) {
      datatypes.set(name, def as any);
    }
  }

  const schemaName = "sensor_msgs/msg/Joy";

  return { schemaName, datatypes: datatypes.size > 0 ? datatypes : undefined };
}

export function JoyPanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [messages, setMessages] = useState<undefined | Immutable<MessageEvent[]>>();
  const [joy, setJoy] = useState<Joy | undefined>();
  const [pubTopic, setPubTopic] = useState<string | undefined>();
  const [advertised, setAdvertised] = useState(false);
  const [kbEnabled, setKbEnabled] = useState<boolean>(true);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("light");

  const [trackedKeys, setTrackedKeys] = useState<Map<string, KbMap>>(() => {
    const keyMap = new Map<string, KbMap>();

    for (const [key, value] of Object.entries(kbmapping1)) {
      const k: KbMap = {
        button: value.button,
        axis: value.axis,
        direction: value.direction === "+" ? 1 : 0,
        value: 0,
      };
      keyMap.set(key, k);
    }
    return keyMap;
  });

  const [config, setConfig] = useState<Config>(() => {
    const partialConfig = context.initialState as Partial<Config>;
    return {
      ...defaultConfig,
      ...partialConfig,
      gamepadId: partialConfig.gamepadId ?? defaultConfig.gamepadId,
      publishMode: partialConfig.publishMode ?? defaultConfig.publishMode,
    };
  });

  const joyAdvertisement = useMemo(() => buildJoyDatatypes(), []);

  const settingsActionHandler = useCallback(
    (action: SettingsTreeAction) => {
      setConfig((prevConfig) => settingsActionReducer(prevConfig, action));
    },
    [setConfig],
  );

  useEffect(() => {
    context.updatePanelSettingsEditor({
      actionHandler: settingsActionHandler,
      nodes: buildSettingsTree(config, topics),
    });
  }, [config, context, settingsActionHandler, topics]);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);
      setMessages(renderState.currentFrame);
      if (renderState.colorScheme) {
        setColorScheme(renderState.colorScheme);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
    context.watch("colorScheme");
  }, [context]);

  useEffect(() => {
    if (config.dataSource === "sub-joy-topic") {
      context.subscribe([config.subJoyTopic]);
    } else {
      context.unsubscribeAll();
    }
  }, [config.subJoyTopic, context, config.dataSource]);

  useEffect(() => {
    const latestJoy = messages?.[messages.length - 1]?.message as Joy | undefined;
    if (latestJoy) {
      setJoy({
        header: {
          stamp: latestJoy.header.stamp,
          frame_id: config.publishFrameId,
        },
        axes: Array.from(latestJoy.axes),
        buttons: Array.from(latestJoy.buttons),
      });
    }
  }, [messages, config.publishFrameId]);

  useGamepad({
    didConnect: useCallback(() => {}, []),
    didDisconnect: useCallback(() => {}, []),
    didUpdate: useCallback(
      (gp: Gamepad) => {
        if (config.dataSource !== "gamepad" || config.gamepadId !== gp.index) {
          return;
        }

        const tmpJoy: Joy = {
          header: {
            frame_id: config.publishFrameId,
            stamp: fromDate(new Date()),
          },
          axes: gp.axes.map((axis) => -axis),
          buttons: gp.buttons.map((button) => (button.pressed ? 1 : 0)),
        };

        setJoy(tmpJoy);
      },
      [config.dataSource, config.gamepadId, config.publishFrameId],
    ),
  });

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    setTrackedKeys((oldTrackedKeys) => {
      if (oldTrackedKeys && oldTrackedKeys.has(event.key)) {
        const newKeys = new Map(oldTrackedKeys);
        const k = newKeys.get(event.key);
        if (k) {
          k.value = 1;
        }
        return newKeys;
      }
      return oldTrackedKeys;
    });
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    setTrackedKeys((oldTrackedKeys) => {
      if (oldTrackedKeys && oldTrackedKeys.has(event.key)) {
        const newKeys = new Map(oldTrackedKeys);
        const k = newKeys.get(event.key);
        if (k) {
          k.value = 0;
        }
        return newKeys;
      }
      return oldTrackedKeys;
    });
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  useEffect(() => {
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      document.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyUp]);

  useEffect(() => {
    if (config.dataSource !== "keyboard" || !kbEnabled) {
      return;
    }

    const axes: number[] = [];
    const buttons: number[] = [];

    trackedKeys.forEach((value) => {
      if (value.button >= 0) {
        while (buttons.length <= value.button) {
          buttons.push(0);
        }
        buttons[value.button] = value.value;
      } else if (value.axis >= 0) {
        while (axes.length <= value.axis) {
          axes.push(0);
        }
        axes[value.axis] += (value.direction > 0 ? 1 : -1) * value.value;
      }
    });

    const tmpJoy: Joy = {
      header: {
        frame_id: config.publishFrameId,
        stamp: fromDate(new Date()),
      },
      axes,
      buttons,
    };

    setJoy(tmpJoy);
  }, [config.dataSource, trackedKeys, config.publishFrameId, kbEnabled]);

  useEffect(() => {
    if (!config.publishMode) {
      setPubTopic(undefined);
      setAdvertised(false);
      return undefined;
    }

    const topic = config.pubJoyTopic;
    if (!topic) {
      return undefined;
    }

    const options = joyAdvertisement.datatypes
      ? { datatypes: joyAdvertisement.datatypes }
      : undefined;
    if (context.advertise && joyAdvertisement.datatypes?.has(joyAdvertisement.schemaName)) {
      context.advertise(topic, joyAdvertisement.schemaName, options);
      setAdvertised(true);
      setPubTopic(topic);
    } else {
      setAdvertised(false);
    }

    return () => {
      context.unadvertise?.(topic);
      setAdvertised(false);
    };
  }, [context, config.publishMode, config.pubJoyTopic, joyAdvertisement]);

  useEffect(() => {
    if (
      !config.publishMode ||
      !pubTopic ||
      !advertised ||
      pubTopic !== config.pubJoyTopic ||
      joy == undefined
    ) {
      return;
    }
    context.publish?.(pubTopic, joy);
  }, [context, config.pubJoyTopic, config.publishMode, joy, pubTopic, advertised]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const handleKbSwitch = (event: React.ChangeEvent<HTMLInputElement>) => {
    setKbEnabled(event.target.checked);
  };

  const interactiveCb = useCallback(
    (interactiveJoy: Joy) => {
      if (config.dataSource !== "interactive") {
        return;
      }
      setJoy({
        header: {
          frame_id: config.publishFrameId,
          stamp: fromDate(new Date()),
        },
        axes: interactiveJoy.axes,
        buttons: interactiveJoy.buttons,
      });
    },
    [config.publishFrameId, config.dataSource],
  );

  useEffect(() => {
    context.saveState(config);
    context.setDefaultPanelTitle("Joystick");
  }, [context, config]);

  return (
    <ThemeProvider isDark={colorScheme === "dark"}>
      {config.dataSource === "keyboard" ? (
        <FormGroup>
          <FormControlLabel
            control={<Switch checked={kbEnabled} onChange={handleKbSwitch} />}
            label="Enable keyboard input"
          />
        </FormGroup>
      ) : null}
      {config.displayMode === "auto" ? <SimpleButtonView joy={joy} /> : null}
      {config.displayMode === "custom" ? (
        <GamepadView joy={joy} cbInteractChange={interactiveCb} layoutName={config.layoutName} />
      ) : null}
      {!joy ? (
        <Typography variant="caption" color="text.secondary">
          Waiting for data...
        </Typography>
      ) : null}
    </ThemeProvider>
  );
}

export function initJoyPanel(context: PanelExtensionContext): () => void {
  ReactDOM.render(<JoyPanel context={context} />, context.panelElement);

  return () => {
    ReactDOM.unmountComponentAtNode(context.panelElement);
  };
}
