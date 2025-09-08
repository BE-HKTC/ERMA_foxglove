// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import FoxgloveWebSocketPlayer from "@foxglove/studio-base/players/FoxgloveWebSocketPlayer";
import { Player } from "@foxglove/studio-base/players/types";

export default class FoxgloveWebSocketDataSourceFactory implements IDataSourceFactory {
  public id = "foxglove-websocket";
  public type: IDataSourceFactory["type"] = "connection";
  public displayName = "Foxglove WebSocket";
  public iconName: IDataSourceFactory["iconName"] = "Flow";
  public description =
    "Connect to a ROS 1, ROS 2, or custom system using the Foxglove WebSocket protocol. For ROS systems, be sure to first install the foxglove_bridge ROS package.";
  public docsLinks = [
    {
      label: "ROS 1",
      url: "https://docs.foxglove.dev/docs/connecting-to-data/frameworks/ros1#foxglove-websocket",
    },
    {
      label: "ROS 2",
      url: "https://docs.foxglove.dev/docs/connecting-to-data/frameworks/ros2#foxglove-websocket",
    },
    {
      label: "custom data",
      url: "https://docs.foxglove.dev/docs/connecting-to-data/frameworks/custom#foxglove-websocket",
    },
  ];

  public formConfig = {
    fields: [
      {
        id: "url",
        label: "WebSocket URL",
        description: "Enter a full WebSocket URL, e.g. ws://10.2.0.100:8765",
        defaultValue: "ws://localhost:8765",
        validate: (newValue: string): Error | undefined => {
          try {
            const url = new URL(newValue);
            if (url.protocol !== "ws:" && url.protocol !== "wss:") {
              return new Error(`Invalid protocol: ${url.protocol}`);
            }
            return undefined;
          } catch (err) {
            // Provide a clearer hint when the scheme is missing
            if (/^[^:]+:\/\//.test(newValue) === false) {
              return new Error("Enter a valid WebSocket URL including scheme, e.g. ws://host:8765");
            }
            return new Error("Enter a valid WebSocket URL");
          }
        },
      },
    ],
  };

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const url = args.params?.url;
    if (!url) {
      return;
    }

    return new FoxgloveWebSocketPlayer({
      url,
      metricsCollector: args.metricsCollector,
      sourceId: this.id,
    });
  }
}
