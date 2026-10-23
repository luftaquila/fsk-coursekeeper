# Formula Student Korea Coursekeeper

Course design and cone layout system for Formula Student Korea dynamic events.

## Features

* Course design on satellite imagery
   * Export as an Assetto Corsa track
* RTK GPS rover that drives to each cone position and marks it
* Handheld RTK GPS unit that captures cone positions or serves as the rover's base station
* [Web console](https://luftaquila.github.io/fsk-coursekeeper/) that keeps courses in the browser

## Usage

### 1. Prepare

1. Open the [web console](https://luftaquila.github.io/fsk-coursekeeper/).
2. In `Settings`, add each device with `+ Rover` or `+ GPS unit` and its address, then click `Save and reload`.
3. Click the `Rover` badge in the header and save an NGII account ID under `Rover NGII login`.
   * Save one for the GPS unit under `GPS unit` → `NGII login`.
4. To use the GPS unit as the rover's base station instead of the NGII network:
   * Place the GPS unit on a fixed point, add the point under `GPS unit` → `Survey points`, and click `Survey`.
   * Under `Rover` → `Corrections`, select `GPS unit as base station` and the point.

### 2. Design a course

1. Enter a name in the course menu at the top left and click `Create`.
2. Select `Add cones`, choose the cone side with `L`, `C`, or `R`, and tap the map.
   * The capture button adds a cone at the GPS unit's position, or at the rover's when the GPS unit is unavailable.

The export button in the course menu downloads the course as an Assetto Corsa track, a JSON file, and a preview image.

### 3. Lay out the cones

1. In `Operate`, click `Plan a mission`, pick the cones and their order, and click `Apply route`.
2. Click `Check and run`, review the preflight check, and click `Run`.
   * The rover stops at each cone, marks it, and moves on.

> [!IMPORTANT]
> `Emergency stop` in the header or the E-stop button on the rover stops the rover at any time.\
> The rover keeps running its mission when the console or the network drops.

| Status light | Rover |
| --- | --- |
| White | Booting |
| Green | Idle |
| Blue | Driving |
| Amber | Low battery |
| Orange, blinking | Mission paused, or halted by a GPS fault |
| Magenta | Battery undervoltage; motors off |
| Red, blinking | E-stop |
| Off | No link to the Raspberry Pi |

### 4. Review

* `Review` → `Missions`: replay a recorded mission on the map.
* `Review` → `Rover logs`: click `Fetch from rover` to load the rover's latest logs.

> [!IMPORTANT]
> Courses are saved in the browser. Back them up with `Settings` → `Export backup`.\
> If the console warns that this browser cannot save courses, export your courses before closing the page.

## Do It Yourself!

### 1. Build the rover

<details>
<summary>Bill of materials</summary>

| Qty | Part |
| ---: | --- |
| 1x | Wheeltec R550 AKM Plus Ackermann chassis |
| 2x | MD36L P27 DC gearmotor with a 500 PPR encoder |
| 1x | Wheeltec S20F steering servo |
| 1x | Cytron MDD10A motor driver |
| 1x | Raspberry Pi 5 |
| 1x | 8–32 V to 5 V, 30 W DC-DC converter for the Raspberry Pi |
| 1x | u-blox ZED-F9P GNSS receiver with antenna |
| 1x | Waveshare RP2040-Zero |
| 1x | Rover PCB with the parts in [`BOM-pcb.csv`](rover/pcb/jlcpcb/production_files/BOM-pcb.csv) |
| 1x | 25.6 V (8S) 6.6 Ah LiFePO4 battery with BMS and XT60 connector |
| 1x | Peristaltic pump with an IRLZ44N MOSFET and a 1N4007 diode |
| 1x | Normally closed momentary E-stop button |
| 2x | NeoPixel Stick (8× WS2812) |
| 1x | Red/green navigation light module (3-pin) |

</details>

1. Order the rover PCB from JLCPCB with [`GERBER-pcb.zip`](rover/pcb/jlcpcb/production_files/GERBER-pcb.zip) and solder its parts.
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
   * In the OS customisation, set a host name such as `fsk-coursekeeper-rover`, a user, an SSH key, and the Wi-Fi network.
2. Run on the rover over SSH:

   ```sh
   curl -fsSL https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/install-rover.sh | sudo bash
   ```

   * On the first run, open the printed link and log in to your tailnet.
   * Enable MagicDNS and HTTPS certificates in the tailnet.
   * Reboot once if the installer asks.
3. Flash `fsk-coursekeeper-rover-mcu.uf2` from the [latest release](https://github.com/luftaquila/fsk-coursekeeper/releases/latest) to the RP2040-Zero:
   * First time: connect it to a computer while holding `BOOT`, then copy the file to the `RPI-RP2` drive.
   * After that: run `sudo flash-mcu fsk-coursekeeper-rover-mcu.uf2` on the rover.
4. In the console, add the rover with the address the installer prints.
5. Under `Rover` → `Battery`, enter a multimeter reading with `Calibrate voltage`.
6. Under `Rover` → `Calibration`, run the `Antenna` and `Wheels` auto calibration.

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

4. In the console, add the GPS unit with the address the installer prints.

### 4. Update

```sh
sudo fsk-coursekeeper-update latest   # or a version such as v1.2.3
```

> [!IMPORTANT]
> Every device and the web console must run the same release.

> [!TIP]
> If a device is unreachable, write its SD card again and reinstall.

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
  python3 -m pip install -r requirements.txt
  python3 -m pytest test/
  ```

### GPS unit

* Requires: Python 3.12

  ```sh
  cd rover/gps
  python3 -m pip install -r requirements.txt
  python3 -m pytest test/
  ```

### MCU firmware

* Requires: CMake, Arm GNU Toolchain (`arm-none-eabi-gcc`, newlib), Pico SDK 2.1.1

  ```sh
  PICO_SDK_PATH=<pico-sdk> cmake -S rover/mcu -B rover/mcu/build -DPICO_BOARD=pico
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
