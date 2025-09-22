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
        description: "Format: ws://host:port (e.g. ws://10.2.0.100:8765)",
        placeholder: "ws://10.2.0.100:8765",
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
            if (!/^[^:]+:\/\//.test(newValue)) {
              return new Error("Enter a valid WebSocket URL including scheme, e.g. ws://host:8765");
            }
            return new Error("Enter a valid WebSocket URL");
          }
        },
      },
      {
        id: "lookback",
        label: "History window (optional)",
        placeholder: "15m, 1h, 24h, 7d",
        description: "Include initial history on connect (ERMA bridge only)",
        validate: (value: string): Error | undefined => {
          if (!value) {return undefined;}
          if (/^\d+(s|m|h|d|w)$/.test(value)) {return undefined;}
          return new Error("Use formats like 30s, 5m, 2h, 1d, 1w");
        },
      },
    ],
  };

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    let url = args.params?.url;
    const lookback = args.params?.lookback;
    if (!url) {
      return;
    }

    // If a lookback window is provided, append as a query parameter
    if (lookback) {
      try {
        const u = new URL(url);
        u.searchParams.set("lookback", lookback);
        url = u.toString();
      } catch {
        // ignore invalid URL; validation will catch elsewhere
      }
    }

    return new FoxgloveWebSocketPlayer({
      url,
      metricsCollector: args.metricsCollector,
      sourceId: this.id,
    });
  }
}
