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

import { Time } from "@foxglove/rostime";

type Header = {
  stamp: Time;
  frame_id: string;
};

// sensor_msgs/Joy message definition
// http://docs.ros.org/en/api/sensor_msgs/html/msg/Joy.html
export type Joy = {
  header: Header;
  axes: number[];
  buttons: number[];
};

export interface ButtonConfig {
  type: string;
  text: string;
  x: number;
  y: number;
  rot: number;
  button: number;
}

export interface BarConfig {
  type: string;
  x: number;
  y: number;
  rot: number;
  axis: number;
}

export interface StickConfig {
  type: string;
  x: number;
  y: number;
  axisX: number;
  axisY: number;
  button: number;
}

export interface DPadConfig {
  type: string;
  x: number;
  y: number;
  axisX: number;
  axisY: number;
}

export type DisplayMapping = (ButtonConfig | BarConfig | StickConfig | DPadConfig)[];
