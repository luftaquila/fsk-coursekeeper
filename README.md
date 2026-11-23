# Formula Student Korea Coursekeeper

Autonomous cone layout rover system for Formula Student Korea dynamic event courses.

## Features

* RTK GPS autonomous rover that drives to each cone position and marks it
* Handheld RTK GPS unit that captures cone positions
* [Web console](https://luftaquila.github.io/fsk-coursekeeper/) that designs courses on satellite imagery

## Usage

### 1. Prepare

1. Log in to your [tailnet](https://tailscale.com/docs/concepts/tailnet) and open the [web console](https://luftaquila.github.io/fsk-coursekeeper/).
2. Save the rover's tailnet address with `+ Rover` in `Settings`.
3. Turn on the rover and wait for it to connect.
4. Save your NGII account email in `Rover NGII login` on the `Rover` badge.
   * For a new account, sign up at the [NGII GNSS Data Center](https://www.gnssdata.or.kr/main/getMainView.do).

### 2. Course design

1. Enter a name in the course menu at the top left and click `Create`.
2. At each cone position, choose a side with `L`, `C`, or `R` and click the capture button.
   * It captures the GPS unit's position, or the rover's without a GPS unit.
   * To add cones manually, select `Add cones` and tap the map.

To export a course, click its download button in the course menu.\
The ZIP includes an Assetto Corsa track, the course data JSON, and a preview image.

### 3. Rover operation

1. Turn on the rover and wait for it to connect.
2. In `Operate`, click `Plan a mission`, pick the cones in order, and click `Check and run`.
3. Review the preflight check and click `Run`.

> [!IMPORTANT]
> `Emergency stop` in the header or the E-stop button on the rover stops the rover at any time.\
> The rover keeps running its mission when the console or the network drops.

| MCU Status light | Rover |
| --- | --- |
| Green | Idle |
| Blue | Driving |
| Amber | Low battery |
| Orange, blinking | Mission paused, or stopped by an error |
| Magenta | Battery undervoltage |
| Red, blinking | E-stop |
| Off | No link to the Raspberry Pi |

### 4. Review

Missions and logs are read from the rover. Turn it on and open `Review`.

* `Missions`: replay a recorded mission on the map.
* `Rover logs`: click `Fetch from rover` to load the latest logs.

> [!IMPORTANT]
> Courses are saved in the browser. Back them up with `Settings` → `Export backup`.\
> If a storage warning appears, export your courses before closing the page.\
> To import an exported course, enter a name in the course menu, click the upload button, and select its JSON.

## Do It Yourself!

### 1. Build the rover

<details>
<summary>Bill of materials</summary>

| Qty | Part |
| ---: | --- |
| 1x | Wheeltec R550 AKM Plus Ackermann chassis |
| 1x | Cytron MDD10A motor driver |
| 1x | Raspberry Pi 5 (4GB+) |
| 1x | 8–32 V to 5 V, 25 W DC-DC converter |
| 1x | u-blox ZED-F9P GNSS receiver with antenna |
| 1x | Waveshare RP2040-Zero |
| 1x | Rover PCB (See below) |
| 1x | 25.6 V (8S) 6.6 Ah LiFePO4 battery with BMS and XT60 connector |
| 1x | Peristaltic pump with an IRLZ44N MOSFET and a 1N4007 diode |
| 1x | Normally closed momentary E-stop button |
| 2x | NeoPixel Stick (8× WS2812, Optional) |
| 1x | Red/green navigation light module (3-pin, Optional) |

</details>

1. Order the PCB from JLCPCB with [`GERBER-pcb.zip`](rover/pcb/jlcpcb/production_files/GERBER-pcb.zip) and solder its parts.
2. Wire the PCB:

   | Connector | Wire to |
   | --- | --- |
   | `J1` BATT | Battery |
   | `J2` E-STOP | E-stop button |
   | `J3` NAV | Navigation lights |
   | `J4` STEER | Steering servo |
   | `J5` DUMP | Pump MOSFET |
   | `J6` TSAL | NeoPixel Sticks |
   | `J7` ENC(L), `J8` ENC(R) | Left and right encoders |
   | `J9` DRIVER | MDD10A |

3. Power the MDD10A and the DC-DC converter from the battery.
4. Connect the RP2040-Zero and the ZED-F9P to the Raspberry Pi over USB.

### 2. Install the rover

1. Write Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager.
   * In the OS customisation, set a host name such as `fsk-coursekeeper-rover`, a user, an SSH key, and Wi-Fi.
2. Enable MagicDNS and HTTPS certificates in the Tailscale admin console.
3. Run on the rover over SSH:

   ```sh
   curl -fsSL https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/install-rover.sh | sudo bash
   ```

   * Open the printed link and log in to your tailnet.
   * Reboot if the installer asks.
4. Hold `BOOT` and press `RESET` on the RP2040-Zero, then flash the MCU firmware:

   ```sh
   curl -fsSLO https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/fsk-coursekeeper-rover-mcu.uf2
   sudo flash-mcu fsk-coursekeeper-rover-mcu.uf2
   ```

5. Follow [Prepare](#1-prepare) with the address the installer prints.
6. Click `Calibrate voltage` under `Battery`, enter the battery voltage measured with a multimeter, and click `Save`.
7. Take the rover outdoors and click `Open` under `Calibration`.
8. Click `Start` in `Antenna`, then in `Wheels`.
   * `Antenna` needs 5 m of space on every side, and `Wheels` needs 12 m ahead.

> [!TIP]
> Run `Antenna` again after moving the GPS antenna, and `Wheels` after replacing a wheel.

### 3. Build and install the GPS unit

Required: Raspberry Pi Zero 2 W, u-blox ZED-F9P GNSS receiver with antenna.

1. 3D-print [`gps_housing.scad`](rover/3d/gps_housing.scad) and connect the ZED-F9P to the Raspberry Pi over USB.
2. Write Raspberry Pi OS Lite (64-bit) as for the rover, with a host name such as `fsk-coursekeeper-gps`.
3. Run on the GPS unit over SSH:

   ```sh
   curl -fsSL https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/install-gps.sh | sudo bash
   ```

   * Open the printed link and log in to your tailnet.
4. Add the address the installer prints with `+ GPS unit` in `Settings` and click `Save`.
5. Click the `GPS unit` badge, enter your NGII account email in `NGII login`, and click `Save`.

### 4. Update

The web console always runs the latest release. Update every device when a new release is out.

1. Run on each device over SSH:

   ```sh
   sudo fsk-coursekeeper-update latest
   ```

2. Flash the MCU firmware on the rover:

   ```sh
   curl -fsSLO https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/fsk-coursekeeper-rover-mcu.uf2
   sudo flash-mcu fsk-coursekeeper-rover-mcu.uf2
   ```

## Development

<details>
<summary>Click to expand</summary>

### Course package and web console

* Requires: Node.js 22, Corepack

  ```sh
  corepack pnpm install
  corepack pnpm test
  corepack pnpm --filter fsk-coursekeeper-console dev    # development server
  corepack pnpm --filter fsk-coursekeeper-console build  # console/dist
  corepack pnpm test:e2e                                 # requires Chrome and Python 3
  ```

### Rover pilot

* Requires: Python 3.12

  ```sh
  cd rover/pilot
  python3 -m pip install -r requirements.txt pytest
  python3 -m pytest test/
  ```

### GPS unit

* Requires: Python 3.12

  ```sh
  cd rover/gps
  python3 -m pip install -r requirements.txt pytest
  python3 -m pytest test/
  ```

### MCU firmware

* Requires: CMake, Arm GNU Toolchain (`arm-none-eabi-gcc`, newlib), Pico SDK 2.1.1

  ```sh
  PICO_SDK_PATH=<pico-sdk> cmake -S rover/mcu -B rover/mcu/build
  cmake --build rover/mcu/build
  ```

### PCB

* Requires: KiCad 10+
* Open [pcb.kicad_pro](rover/pcb/pcb.kicad_pro)

### 3D models

* Requires: OpenSCAD
* Open the models in [rover/3d](rover/3d)

</details>

## LICENSE

For non-commercial use only:

```
"THE BEERWARE LICENSE" (Revision 42):
LUFT-AQUILA wrote this project. As long as you retain this notice,
you can do whatever you want with this stuff. If we meet someday,
and you think this stuff is worth it, you can buy me a beer in return.
```

이 저장소의 모든 내용은 비상업적 용도로 자유롭게 사용할 수 있습니다.\
이 프로젝트가 마음에 든다면, 언젠가 우리가 만나게 되었을 때 맥주 한 잔 사 주세요.
