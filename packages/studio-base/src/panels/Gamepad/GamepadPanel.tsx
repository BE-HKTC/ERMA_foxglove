// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ros1 } from "@foxglove/rosmsg-msgs-common";
import {
  PanelExtensionContext,
  SettingsTreeAction,
  SettingsTreeNode,
  SettingsTreeNodes,
  Topic,
} from "@foxglove/studio";
import EmptyState from "@foxglove/studio-base/components/EmptyState";
import Stack from "@foxglove/studio-base/components/Stack";
import ThemeProvider from "@foxglove/studio-base/theme/ThemeProvider";

type Props = { context: PanelExtensionContext };

type Config = {
  topic?: string;
  publishRate: number; // Hz
  deadzone: number; // 0..1
  linearAxis: { x: number; y: number }; // axes indices for linear x (forward/back) and y (strafe)
  angularAxis: { z: number }; // axis index for angular z (turn)
  scale: { linear: number; angular: number };
};

function clampDeadzone(value: number, dz: number): number {
  if (Math.abs(value) < dz) return 0;
  const sign = Math.sign(value);
  const t = (Math.abs(value) - dz) / (1 - dz);
  return sign * Math.min(1, Math.max(0, t));
}

function buildSettingsTree(config: Config, topics: readonly Topic[]): SettingsTreeNodes {
  const general: SettingsTreeNode = {
    label: "General",
    fields: {
      publishRate: { label: "Publish rate (Hz)", input: "number", value: config.publishRate },
      topic: {
        label: "Twist topic",
        input: "autocomplete",
        value: config.topic,
        items: topics.map((t) => t.name),
      },
      deadzone: { label: "Deadzone", input: "number", value: config.deadzone, step: 0.01, min: 0, max: 1 },
      linearScale: { label: "Linear scale", input: "number", value: config.scale.linear, step: 0.1 },
      angularScale: { label: "Angular scale", input: "number", value: config.scale.angular, step: 0.1 },
    },
    children: {
      axes: {
        label: "Axes mapping",
        fields: {
          linearX: { label: "Linear X axis", input: "number", value: config.linearAxis.x, step: 1 },
          angularZ: { label: "Angular Z axis", input: "number", value: config.angularAxis.z, step: 1 },
        },
      },
    },
  };
  return { general };
}

export default function GamepadPanel({ context }: Props): JSX.Element {
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("light");
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [renderDone, setRenderDone] = useState<() => void>(() => () => {});

  const [config, setConfig] = useState<Config>(() => {
    const initial = (context.initialState ?? {}) as Partial<Config>;
    return {
      topic: initial.topic,
      publishRate: initial.publishRate ?? 20,
      deadzone: initial.deadzone ?? 0.15,
      linearAxis: initial.linearAxis ?? { x: 1, y: 0 }, // Xbox: left stick: axes[0]=x, axes[1]=y
      angularAxis: initial.angularAxis ?? { z: 0 }, // turn from left stick X by default
      scale: initial.scale ?? { linear: 1.0, angular: 1.0 },
    };
  });

  const settingsActionHandler = useCallback((action: SettingsTreeAction) => {
    if (action.action !== "update") return;
    setConfig((prev) => {
      const next = { ...prev } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const [_, key] = action.payload.path; // ["general", key]
      if (key === "topic" || key === "publishRate" || key === "deadzone") {
        (next as any)[key] = action.payload.value;
      } else if (key === "linearScale") {
        next.scale = { ...next.scale, linear: Number(action.payload.value) };
      } else if (key === "angularScale") {
        next.scale = { ...next.scale, angular: Number(action.payload.value) };
      } else if (key === "axes") {
        // ignore
      } else if (key === "linearX") {
        next.linearAxis = { ...next.linearAxis, x: Number(action.payload.value) };
      } else if (key === "angularZ") {
        next.angularAxis = { ...next.angularAxis, z: Number(action.payload.value) };
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    context.watch("topics");
    context.watch("colorScheme");
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics ?? []);
      if (renderState.colorScheme) setColorScheme(renderState.colorScheme);
    };
  }, [context]);

  // Update settings UI + persist state
  useEffect(() => {
    const tree = buildSettingsTree(config, topics);
    context.updatePanelSettingsEditor({ actionHandler: settingsActionHandler, nodes: tree });
    context.saveState(config);
  }, [config, topics, context, settingsActionHandler]);

  // Advertise Twist topic
  useLayoutEffect(() => {
    if (!config.topic) return;
    context.advertise?.(config.topic, "geometry_msgs/Twist", {
      datatypes: new Map([
        ["geometry_msgs/Vector3", ros1["geometry_msgs/Vector3"]],
        ["geometry_msgs/Twist", ros1["geometry_msgs/Twist"]],
      ]),
    });
    return () => context.unadvertise?.(config.topic!);
  }, [context, config.topic]);

  // Poll the Gamepad API and publish Twist at configured rate
  const lastPublishRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      if (!config.topic || !context.publish || config.publishRate <= 0) return;
      const intervalMs = 1000 / config.publishRate;
      if (time - lastPublishRef.current < intervalMs) return;
      lastPublishRef.current = time;

      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = pads && pads.length > 0 ? pads[0] : undefined;
      if (!pad) return;

      const ax = (i: number) => (Number.isFinite(pad.axes[i]!) ? pad.axes[i]! : 0);
      // Xbox left stick: axes[0] (left/right), axes[1] (up/down). Invert Y to make up positive.
      const x = clampDeadzone(-ax(config.linearAxis.x), config.deadzone) * config.scale.linear;
      const z = clampDeadzone(ax(config.angularAxis.z), config.deadzone) * config.scale.angular;

      const message = {
        linear: { x, y: 0, z: 0 },
        angular: { x: 0, y: 0, z },
      };
      context.publish(config.topic, message);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [context, config.topic, config.publishRate, config.deadzone, config.linearAxis.x, config.angularAxis.z, config.scale.linear, config.scale.angular]);

  useLayoutEffect(() => {
    renderDone();
  }, [renderDone]);

  // Simple UI to show connection status and live axes/buttons
  const [gamepadInfo, setGamepadInfo] = useState<string>("No gamepad");
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = pads && pads.length > 0 ? pads[0] : undefined;
      if (pad) {
        const axes = pad.axes.map((v) => v.toFixed(2)).join(", ");
        const buttons = pad.buttons.map((b) => (b.pressed ? "1" : "0")).join("");
        setGamepadInfo(`${pad.id} | axes: [${axes}] | buttons: ${buttons}`);
      } else {
        setGamepadInfo("No gamepad");
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const canPublish = context.publish != undefined && (config.publishRate ?? 0) > 0;
  const hasTopic = Boolean(config.topic);

  return (
    <ThemeProvider isDark={colorScheme === "dark"}>
      <Stack fullHeight justifyContent="center" alignItems="center" style={{ padding: 8, textAlign: "center" }}>
        {!canPublish && <EmptyState>Connect to a data source that supports publishing</EmptyState>}
        {canPublish && !hasTopic && <EmptyState>Select a Twist publish topic in the panel settings</EmptyState>}
        <div style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{gamepadInfo}</div>
        <div style={{ opacity: 0.7, marginTop: 8 }}>
          Left stick: forward/back (linear x), left/right (angular z)
        </div>
      </Stack>
    </ThemeProvider>
  );
}

