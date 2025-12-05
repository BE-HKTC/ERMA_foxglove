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

type GamepadDebugProps = {
  gamepads: Record<string, Gamepad>;
};

export function GamepadDebug({ gamepads }: GamepadDebugProps) {
  const gamepadDisplay = Object.keys(gamepads).map((gamepadId) => {
    const pad = gamepads[gamepadId];
    return (
      <div key={gamepadId}>
        <h2>{pad.id}</h2>
        {pad.buttons?.map((button, index) => (
          <div key={index}>
            {index}: {button.pressed ? "True" : "False"}
          </div>
        ))}
        {pad.axes?.map((axis, index) => (
          <div key={index}>
            {index}: {axis}
          </div>
        ))}
      </div>
    );
  });

  return <div>{gamepadDisplay}</div>;
}
