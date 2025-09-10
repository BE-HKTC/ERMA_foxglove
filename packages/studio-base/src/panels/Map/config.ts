// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { filterMap } from "@foxglove/den/collection";
import { SettingsTreeFields, SettingsTreeNodes, Topic } from "@foxglove/studio";

// Persisted panel state
export type Config = {
  center?: { lat: number; lon: number };
  customTileUrl: string;
  disabledTopics: string[];
  followTopic: string;
  layer: string;
  topicColors: Record<string, string>;
  zoomLevel?: number;
  maxNativeZoom?: number;
  pinSize?: number;
  previewPinColor?: string;
};

export function validateCustomUrl(url: string): Error | undefined {
  const placeholders = url.match(/\{.+?\}/g) ?? [];
  const validPlaceholders = ["{x}", "{y}", "{z}"];
  for (const placeholder of placeholders) {
    if (!validPlaceholders.includes(placeholder)) {
      return new Error(`Invalid placeholder ${placeholder}`);
    }
  }

  return undefined;
}

function isGeoJSONSchema(schemaName: string) {
  switch (schemaName) {
    case "foxglove_msgs/GeoJSON":
    case "foxglove_msgs/msg/GeoJSON":
    case "foxglove::GeoJSON":
    case "foxglove.GeoJSON":
      return true;
    default:
      return false;
  }
}

export function buildSettingsTree(
  config: Config,
  eligibleTopics: Omit<Topic, "datatype">[],
): SettingsTreeNodes {
  const topics: SettingsTreeNodes = _.transform(
    eligibleTopics,
    (result, topic) => {
      const coloring = config.topicColors[topic.name];
      result[topic.name] = {
        label: topic.name,
        fields: {
          enabled: {
            label: "Enabled",
            input: "boolean",
            value: !config.disabledTopics.includes(topic.name),
          },
          coloring: {
            label: "Coloring",
            input: "select",
            value: coloring ? "Custom" : "Automatic",
            options: [
              { label: "Automatic", value: "Automatic" },
              { label: "Custom", value: "Custom" },
            ],
          },
          color: coloring
            ? {
                label: "Color",
                input: "rgb",
                value: coloring,
              }
            : undefined,
        },
      };
    },
    {} as SettingsTreeNodes,
  );

  const eligibleFollowTopicOptions = filterMap(eligibleTopics, (topic) =>
    config.disabledTopics.includes(topic.name) || isGeoJSONSchema(topic.schemaName)
      ? undefined
      : { label: topic.name, value: topic.name },
  );
  const followTopicOptions = [{ label: "Off", value: "" }, ...eligibleFollowTopicOptions];
  const generalSettings: SettingsTreeFields = {
    layer: {
      label: "Tile layer",
      input: "select",
      value: config.layer,
      options: [
        { label: "Map", value: "map" },
        { label: "Satellite", value: "satellite" },
        { label: "Custom", value: "custom" },
      ],
    },
    centerLat: {
      label: "Default center latitude",
      input: "number",
      value: config.center?.lat,
      help: "Set the initial map center latitude (e.g. 48.8566)",
    },
    centerLon: {
      label: "Default center longitude",
      input: "number",
      value: config.center?.lon,
      help: "Set the initial map center longitude (e.g. 2.3522)",
    },
    zoomLevel: {
      label: "Default zoom level",
      input: "number",
      value: config.zoomLevel ?? 10,
      help: "1 (far) to 24 (close)",
    },
    pinSize: {
      label: "Pin size",
      input: "number",
      value: config.pinSize ?? 3,
      help: "Marker radius in pixels",
    },
    previewPinColor: {
      label: "Preview pin color",
      input: "rgb",
      value: config.previewPinColor,
      help: "Color for the single preview marker (optional)",
    },
  };

  // Only show the custom url input when the user selects the custom layer
  if (config.layer === "custom") {
    let error: string | undefined;
    if (config.customTileUrl.length > 0) {
      error = validateCustomUrl(config.customTileUrl)?.message;
    }

    generalSettings.customTileUrl = {
      label: "Custom map tile URL",
      input: "string",
      value: config.customTileUrl,
      error,
    };

    generalSettings.maxNativeZoom = {
      label: "Max tile level",
      input: "select",
      value: config.maxNativeZoom,
      options: [18, 19, 20, 21, 22, 23, 24].map((num) => {
        return { label: String(num), value: num };
      }),
      help: "Highest zoom supported by the custom map source. See https://leafletjs.com/examples/zoom-levels/ for more information.",
    };
  }

  generalSettings.followTopic = {
    label: "Follow topic",
    input: "select",
    value: config.followTopic,
    options: followTopicOptions,
  };

  generalSettings.setToCurrentView = {
    label: "Set to current view",
    input: "boolean",
    value: false,
    help: "Click On to capture the map's current center and zoom as defaults",
  };

  const settings: SettingsTreeNodes = {
    general: {
      label: "General",
      fields: generalSettings,
    },
    topics: {
      label: "Topics",
      children: topics,
    },
  };

  return settings;
}
