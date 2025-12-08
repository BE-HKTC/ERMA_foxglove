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

import { produce } from "immer";
import * as _ from "lodash-es";

import { SettingsTreeAction, SettingsTreeFields, SettingsTreeNodes, Topic } from "@foxglove/studio";

export type Config = {
  dataSource: "sub-joy-topic" | "gamepad" | "interactive" | "keyboard";
  subJoyTopic: string;
  gamepadId: number;
  publishMode: boolean;
  pubJoyTopic: string;
  publishFrameId: string;
  displayMode: "auto" | "custom";
  debugGamepad: boolean;
  layoutName: "steamdeck" | "ipega-9083s" | "xbox" | "cheapo";
  mapping_name: string;
};

export const defaultConfig: Config = {
  dataSource: "sub-joy-topic",
  subJoyTopic: "/joy",
  gamepadId: 0,
  publishMode: false,
  pubJoyTopic: "/joy",
  publishFrameId: "",
  displayMode: "auto",
  debugGamepad: false,
  layoutName: "steamdeck",
  mapping_name: "default",
};

export function settingsActionReducer(prevConfig: Config, action: SettingsTreeAction): Config {
  return produce(prevConfig, (draft) => {
    if (action.action === "update") {
      const { path, value } = action.payload;
      _.set(draft, path.slice(1), value);
    }
  });
}

function joyTopics(topics?: readonly Topic[]) {
  return (topics ?? []).filter(
    (topic) =>
      topic.schemaName === "sensor_msgs/msg/Joy" || topic.datatype === "sensor_msgs/msg/Joy",
  );
}

export function buildSettingsTree(config: Config, topics?: readonly Topic[]): SettingsTreeNodes {
  const dataSourceFields: SettingsTreeFields = {
    dataSource: {
      label: "Data Source",
      input: "select",
      value: config.dataSource,
      options: [
        { label: "Subscribed Joy Topic", value: "sub-joy-topic" },
        { label: "Gamepad", value: "gamepad" },
        { label: "Interactive", value: "interactive" },
        { label: "Keyboard", value: "keyboard" },
      ],
    },
    subJoyTopic: {
      label: "Subsc. Joy Topic",
      input: "select",
      value: config.subJoyTopic,
      disabled: config.dataSource !== "sub-joy-topic",
      options: joyTopics(topics).map((topic) => ({
        label: topic.name,
        value: topic.name,
      })),
    },
    gamepadId: {
      label: "Gamepad ID",
      input: "select",
      value: config.gamepadId,
      disabled: config.dataSource !== "gamepad",
      options: [
        { label: "0", value: 0 },
        { label: "1", value: 1 },
        { label: "2", value: 2 },
        { label: "3", value: 3 },
      ],
    },
    gamepadMapping: {
      label: "GP->Joy Mapping",
      input: "select",
      value: "default",
      disabled: config.dataSource !== "gamepad",
      options: [
        { label: "Default", value: "default" },
        { label: "TODO Make selectable", value: "todo" },
      ],
    },
  };
  const publishFields: SettingsTreeFields = {
    publishMode: {
      label: "Publish Mode",
      input: "boolean",
      value: config.publishMode,
      disabled: config.dataSource === "sub-joy-topic",
    },
    pubJoyTopic: {
      label: "Pub Joy Topic",
      input: "string",
      value: config.pubJoyTopic,
    },
    publishFrameId: {
      label: "Joy Frame ID",
      input: "string",
      value: config.publishFrameId,
    },
  };
  const displayFields: SettingsTreeFields = {
    displayMode: {
      label: "Display Mode",
      input: "select",
      value: config.displayMode,
      options: [
        { label: "Auto-Generated", value: "auto" },
        { label: "Custom Display", value: "custom" },
      ],
    },
    layoutName: {
      label: "Layout",
      input: "select",
      disabled: config.displayMode === "auto",
      value: config.layoutName,
      options: [
        { label: "Steam Deck", value: "steamdeck" },
        { label: "iPega PG-9083s", value: "ipega-9083s" },
        { label: "Xbox", value: "xbox" },
        { label: "Cheap Controller", value: "cheapo" },
      ],
    },
    debugGamepad: {
      label: "Debug Gamepad",
      input: "boolean",
      value: config.debugGamepad,
    },
  };

  const settings: SettingsTreeNodes = {
    dataSource: { label: "Data Source", fields: dataSourceFields },
    publish: { label: "Publish", fields: publishFields },
    display: { label: "Display", fields: displayFields },
  };

  return settings;
}
