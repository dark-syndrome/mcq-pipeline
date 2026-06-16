# Robotics and ROS 2 Knowledge Reference

---

## URDF: Links and Joints

**URDF (Unified Robot Description Format)** is an XML-based file format that defines the complete physical structure of a robot — its geometry, mass, and joint relationships. It is a purely descriptive data file with no loops, variables, logic, or active commands.

**Link** is a rigid body component (the "bones" of a robot). Each link has up to three sub-elements: `<visual>` (appearance for human operators, can use high-resolution 3D meshes), `<collision>` (boundary for physics collision detection, always simplified to basic shapes like boxes or cylinders to reduce compute cost), and `<inertial>` (mass and rotational inertia tensor, required by physics simulators like Gazebo — omitting it causes the link to behave as massless, making the robot float or fall through the floor). RViz ignores `<inertial>` entirely; only Gazebo requires it.

**Joint** connects two links and defines the motion allowed between them. Every joint specifies a `<parent>` link and a `<child>` link. The `<axis xyz="..."/>` tag defines the normalized vector for rotation or sliding direction — setting the wrong axis causes the joint to move in the wrong physical direction.

The four core joint types and their properties:

| Joint Type | Motion | Limits Required | Real Example |
|---|---|---|---|
| `fixed` | No movement — rigid weld | None | Camera bolted to chassis |
| `revolute` | Rotation around one axis | Yes (angle min/max) | Elbow, windshield wiper |
| `continuous` | Infinite rotation, no bounds | None | Wheel, ceiling fan |
| `prismatic` | Linear sliding along one axis | Yes (position min/max) | Elevator shaft, drawer |

URDF defines the robot as a **directed acyclic graph (DAG)** — every robot has exactly one root link, every child link has exactly one parent, and no closed kinematic loops are possible. For parallel linkages (delta robots), the tree must be kept open and loop closure enforced at runtime in the physics engine.

A minimal URDF skeleton looks like:
```xml
<?xml version="1.0"?>
<robot name="my_robot">
  <link name="base_link">
    <visual><geometry><box size="0.6 0.4 0.2"/></geometry></visual>
  </link>
</robot>
```

A continuous joint for a wheel:
```xml
<joint name="chassis_to_left_wheel" type="continuous">
  <parent link="chassis"/>
  <child link="left_wheel"/>
  <origin xyz="0.1 0.175 -0.05" rpy="1.5708 0 0"/>
  <axis xyz="0 1 0"/>   <!-- spin around Y-axis to roll forward -->
</joint>
```

**Key misconception:** The `<collision>` geometry should match the detailed visual mesh for safety. CORRECT: Using the exact visual mesh for collision is computationally prohibitive — always use a simplified bounding geometry (box or cylinder). A wheel with 10,000 polygon treads freezes the collision engine; a plain cylinder takes microseconds.

When a joint rotates or slides, ROS automatically tracks all coordinate changes for the child link and every downstream link. Developers never manually update child positions.

---

## XACRO: XML Macros for Reusable Robot Models

**XACRO** is an XML macro preprocessor that adds **properties** (variables), **math expressions**, and **macros** (reusable code blocks) to URDF. XACRO cannot be loaded directly by ROS nodes — it must first be compiled into a flat URDF by a parser tool.

A **property** is declared once and referenced with `${name}` syntax. Math is evaluated inline inside `${}` using standard arithmetic operators (`+`, `-`, `*`, `/`). The XACRO namespace declaration `xmlns:xacro="http://www.ros.org/wiki/xacro"` is required in the root `<robot>` tag.

```xml
<xacro:property name="wheel_radius" value="0.1"/>
<xacro:property name="track_width" value="0.35"/>
<!-- Used as: radius="${wheel_radius}" or "${wheel_radius * 2}" -->
```

A **macro** is a template that accepts parameters and generates XML:
```xml
<xacro:macro name="wheel_generator" params="prefix side_y">
  <link name="${prefix}_wheel">
    <visual><geometry><cylinder radius="${wheel_radius}" length="0.05"/></geometry></visual>
  </link>
  <joint name="chassis_to_${prefix}_wheel" type="continuous">
    <parent link="base_link"/>
    <child link="${prefix}_wheel"/>
    <origin xyz="0.15 ${side_y} 0" rpy="1.5708 0 0"/>
    <axis xyz="0 1 0"/>
  </joint>
</xacro:macro>

<!-- Instantiate for left and right wheels — DRY principle -->
<xacro:wheel_generator prefix="left"  side_y="0.175"/>
<xacro:wheel_generator prefix="right" side_y="-0.175"/>
```

Using XACRO eliminates copy-paste errors, makes parameter tuning (e.g., changing wheel radius) a single-line edit, and dramatically reduces file size for robots with repeated components (4 identical wheels, 6 arm joints). Files use `.xacro` or `.urdf.xacro` extensions. **WRONG:** ROS 2 can directly simulate a `.xacro` file. **CORRECT:** A parser tool must compile XACRO to plain URDF first — ROS nodes only understand flat URDF.

---

## Sensor Plugins in Gazebo

A **sensor plugin** is a modular software block injected into a robot's description that tells the Gazebo physics engine to generate synthetic sensor data and broadcast it as ROS 2 topics. Every simulated sensor requires TWO definition components: (1) a kinematic body — a `<link>` and a `<joint>` (usually `fixed`) that locates the sensor precisely on the robot, and (2) a `<gazebo>` plugin block attached to that link that configures data generation.

The three standard sensor types and their ROS 2 output:

| Sensor | What It Simulates | ROS 2 Message Type | Default Topic |
|---|---|---|---|
| Camera | RGB pixel frames | `sensor_msgs/msg/Image` | `/camera/image_raw` |
| LiDAR (ray) | 2D/3D distance scans | `sensor_msgs/msg/LaserScan` | `/scan` |
| IMU | Linear acceleration + angular velocity | `sensor_msgs/msg/Imu` | `/imu/data` |

**LiDAR** (Light Detection and Ranging) spins a laser beam to measure distances, outputting a point cloud. **IMU** (Inertial Measurement Unit) tracks acceleration and rotation rates.

Key LiDAR plugin parameters: `<update_rate>` sets Hz (e.g., 40 Hz), `<samples>` sets number of rays per scan (e.g., 720), `<min_angle>`/`<max_angle>` define the scan arc in radians (−1.5708 to 1.5708 = −90° to +90°), `<range><min>` and `<max>` set detection bounds in meters, and `<noise>` adds Gaussian noise.

**Why add noise?** Perfect simulation sensors return mathematically exact data. Real sensors suffer from dust, lens distortion, and electrical interference. Adding Gaussian noise forces navigation algorithms to be robust enough for real-world deployment — skipping noise creates algorithms that work in simulation but fail on physical hardware (the sim-to-real gap).

Full LiDAR plugin example:
```xml
<gazebo reference="lidar_link">
  <sensor type="ray" name="head_hokuyo_sensor">
    <update_rate>40</update_rate>
    <ray>
      <scan>
        <horizontal>
          <samples>720</samples>
          <min_angle>-1.5708</min_angle>
          <max_angle>1.5708</max_angle>
        </horizontal>
      </scan>
      <range><min>0.10</min><max>30.0</max><resolution>0.01</resolution></range>
    </ray>
    <plugin name="gazebo_ros_ray" filename="libgazebo_ros_ray_sensor.so">
      <ros><argument>~/out:=scan</argument></ros>
      <output_type>sensor_msgs/LaserScan</output_type>
    </plugin>
  </sensor>
</gazebo>
```

**Misconception:** Adding a camera plugin instantly slows down all robot operations. **CORRECT:** It increases GPU/CPU load inside Gazebo for rendering. RViz visualization is completely unaffected. Keep ray counts and image frame rates low (10–30 fps) for manageable simulation performance.

---

## RViz Visualization vs. Gazebo Simulation

**RViz** (ROS Visualization) is the default 3D visual dashboard in ROS for displaying robot models, sensor streams, coordinate frames, and navigation paths. It is a **pure visualization tool** — no physics engine, no gravity, no collision detection. A robot in RViz passes through walls like a ghost.

**Gazebo** is a full physics simulator that applies gravity, friction, and collision laws. It generates synthetic sensor data. A robot in Gazebo bounces off walls and falls when unsupported.

Critical distinction table:

| Feature | RViz | Gazebo |
|---|---|---|
| Purpose | Visualization only | Full physics simulation |
| Gravity | No | Yes |
| Collisions | Ignored | Calculated |
| Sensor data | Displays (from any source) | Generates synthetically |
| `<inertial>` required | No | Yes (missing = robot floats) |
| Can robot pass through wall? | Yes (ghost) | No |

**robot_state_publisher** is the core ROS 2 node that reads a URDF file, combines it with current joint positions, and broadcasts the complete 3D spatial transform of every link on the `/tf` topic. **joint_state_publisher** tracks current positions of movable joints and broadcasts on `/joint_states`. **joint_state_publisher_gui** adds interactive slider bars for manually controlling joints. **TF (Transform Library)** is the underlying system computing how every robot part relates to every other in 3D space.

The three-node RViz pipeline:
```
[URDF file] → [robot_state_publisher] ← [joint_state_publisher]
                        ↓ (computes 3D transform tree)
                    [RViz] (renders shapes)
```

Launch command: `ros2 launch urdf_tutorial_spawner display.launch.py model:=rover.urdf`

**Common error:** `No transform from [wheel_link] to [base_link]` — means a broken joint chain. Every link must have an unbroken path of joints back to the root `base_link`. If any single joint is missing, TF cannot compute the part's position and it fails to render.

---

## SLAM: Simultaneous Localization and Mapping

**SLAM** is the computational problem of building a map of an unknown environment while simultaneously tracking position within that map — solving a circular "chicken-and-egg" problem (accurate mapping requires knowing position; knowing position requires a map) through iterative guess-and-correct cycles.

**Localization** answers "Where am I right now?" **Mapping** answers "What does the environment look like?" **Odometry drift** is the accumulated error from small wheel-slip events that causes the robot's self-estimated position to diverge from its true position over time. A SLAM algorithm corrects this by comparing live LiDAR data against the built map (trusting eyes over feet). **Loop closure** occurs when the robot re-enters a previously mapped area — this triggers **pose graph optimization** that mathematically corrects all accumulated map distortions, snapping the map into a precise closed loop.

**Occupancy Grid Map** is the standard SLAM output — a 2D grid where each cell stores a probability that the corresponding physical space is occupied. **Resolution** is the physical size of one cell (e.g., `0.05` = 5 cm per pixel). Lower resolution = coarser map; higher resolution = finer map but more memory.

Cell color coding and meaning:

| Color | Meaning | Occupancy Probability |
|---|---|---|
| White | Free space — safe to drive | 0% |
| Black | Obstacle or wall — lethal | 100% |
| Grey | Unknown — unexplored | 50% |

**Why do walls look fuzzy?** At 5 cm resolution, a flat wall looks like a staircase. Laser vibration and surface reflections add variability. Probability averaging over multiple sensor readings creates thick, slightly pixelated lines. This is expected behavior, not an error.

**slam_toolbox** is the standard open-source ROS 2 SLAM package. It subscribes to `/scan` (LiDAR) and `/odom` (wheel odometry). It publishes to `/map` as `nav_msgs/OccupancyGrid`. Default mode: `online_async` — builds the map in real-time without blocking robot movement. Internally it stores a **Pose Graph** (a web of historical robot positions and spatial connections), not just a flat image, enabling retroactive error correction. Launch: `ros2 launch slam_toolbox online_async_launch.py`.

**Performance rule:** Always drive very slowly when mapping. If the robot moves faster than the SLAM algorithm processes data, the math breaks and the map becomes fragmented. **Dynamic obstacles:** When a human walks past the LiDAR, the hit cell does NOT permanently mark as occupied — each new laser reading updates the probability. The hit cell rises to ~70% occupied; when the human moves away and the laser passes through again, it drops back to near 0%. The grid uses Bayesian averaging over multiple readings.

**Misconception:** SLAM is a physical sensor you purchase. **CORRECT:** SLAM is a software algorithm. You buy a LiDAR and wheel encoders; you run software (like slam_toolbox) that performs the SLAM mathematics on their data.

---

## Physics Simulation Concepts

**Simulation** is the imitation of a real-world system in software, where a physics engine enforces laws of gravity, friction, and collision. A **physics engine** calculates rigid-body dynamics by iterating through mathematical time steps (e.g., every 0.001 seconds). **Determinism** is the property that identical starting conditions always produce identical results — simulations are deterministic; the real world is not.

**Real-Time Factor (RTF)** is the ratio of simulation speed to real-world speed: RTF = 2.0 means the simulation runs twice as fast as real life; RTF = 0.5 means half speed; RTF < 1.0 indicates the simulation is computationally overloaded.

**Sim-to-Real Gap** is the difference between perfect simulation conditions and messy real-world physics. Code working in simulation may fail on physical hardware because: wheels are not perfect circles, floor is not perfectly flat, sensors have electronic noise, motors overheat, and surfaces have unexpected friction. Adding Gaussian sensor noise, imperfect actuator models, and terrain variation during simulation reduces this gap.

**Spawning** a robot means loading its URDF into Gazebo at specified [X, Y, Z] coordinates. During spawning: the URDF is loaded into the ROS parameter server as a string, a spawn node translates XML tags into physics-engine properties, Gazebo applies gravity to masses defined in `<inertial>` tags, and the physics engine enforces collision detection and joint constraints.

The `<inertial>` tag requirement:
```xml
<inertial>
  <mass value="1.5"/>
  <inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/>
</inertial>
```
Missing `<inertial>` → link treated as massless → robot floats or falls through floor. Zero mass → physics solver division-by-zero → model glitches. RViz ignores inertial data entirely.

| Property | Required by RViz | Required by Gazebo |
|---|---|---|
| `<visual>` | Yes | Optional |
| `<collision>` | No | Yes |
| `<inertial>` | No | Yes (critical) |

---

## Robot Mathematics: Coordinate Frames and Transformations

A **coordinate frame** is a mathematical system with an origin point and X, Y, Z axes defining a specific viewpoint in space. A **vector** is a quantity with magnitude and direction representing a position or velocity (e.g., `[2, 3]` = 2 units forward, 3 units left). A **matrix** is a rectangular array of numbers that acts as a transformation machine — input: a position vector; output: the same position from a different viewpoint.

Common frames: World Frame (global environment reference), Robot Base Frame (robot's body center), Camera Frame (robot's sensor viewpoint).

The **2D rotation matrix** transforms a position vector when the observer has rotated by angle θ:

$$R = \begin{bmatrix} \cos(\theta) & -\sin(\theta) \\ \sin(\theta) & \cos(\theta) \end{bmatrix}$$

New position: V' = R · V

The **2D homogeneous transformation matrix** combines rotation AND translation (shift) in one 3×3 matrix:

$$T = \begin{bmatrix} \cos(\theta) & -\sin(\theta) & x_{shift} \\ \sin(\theta) & \cos(\theta) & y_{shift} \\ 0 & 0 & 1 \end{bmatrix}$$

The top-left 2×2 block handles rotation; the top-right column handles translation; the bottom row `[0, 0, 1]` is mathematical padding enabling correct matrix multiplication. **Position** answers "where is it?"; **Orientation** answers "which way is it facing?" — a transformation matrix handles both simultaneously.

**Euler Angles (Roll, Pitch, Yaw)** represent 3D rotation as three angles around X, Y, Z axes respectively. Intuitive but suffer from **Gimbal Lock** — a condition where two axes align, causing loss of one degree of rotational freedom (occurs when Pitch = ±90°). In URDF, `rpy` stands for Roll-Pitch-Yaw in radians (e.g., `rpy="1.5708 0 0"` = 90° rotation around X-axis).

**Quaternion** is a 4-component representation of 3D rotation (x, y, z, w) that avoids gimbal lock entirely and is computationally efficient. Quaternions are used internally by ROS TF2 for all transform calculations, even though URDF accepts Euler angles for human authoring convenience.

---

## Differential Drive Kinematics

**Kinematics** is the geometry of motion (speeds, distances, angles) without considering forces or mass — not to be confused with dynamics. **Differential drive** is a drive mechanism where two independently controlled wheels on opposite sides steer by spinning at different speeds — no separate steering axle.

Key parameters: **Baseline / Track width (L)** = distance between left and right wheels; **Wheel radius (r)** = distance from wheel center to edge; **Linear velocity (v)** = forward/backward speed of the robot center (m/s); **Angular velocity (ω)** = how fast the robot body turns (rad/s).

Forward kinematics equations (motor angular speeds ω_R and ω_L → robot motion):

| Quantity | Formula |
|---|---|
| Wheel ground speed | $v_{R} = r \cdot \omega_{R}$, $v_{L} = r \cdot \omega_{L}$ |
| Robot linear velocity | $v = (v_R + v_L) / 2$ |
| Robot angular velocity | $\omega = (v_R - v_L) / L$ |

Special cases:

| Condition | Motion |
|---|---|
| $v_L = v_R$ | Drives perfectly straight |
| $v_L = 0$, $v_R > 0$ | Pivots around the stopped left wheel |
| $v_R = -v_L$ | Spins in place (zero linear velocity) |
| $v_R > v_L$ | Curves to the left |

Worked example: r = 0.1 m, L = 0.5 m, ω_R = 20 rad/s, ω_L = 10 rad/s → v_R = 2.0 m/s, v_L = 1.0 m/s → linear velocity v = 1.5 m/s forward, angular velocity ω = (2.0 − 1.0) / 0.5 = 2.0 rad/s (curving left because right wheel is faster). Larger baseline (L) → slower turning for same wheel speed difference. Larger wheel radius (r) → faster linear movement for same motor RPM. The robot body ω is fundamentally different from ω_R and ω_L (individual wheel spinning speeds).

---

## Nav2: Navigation Framework

**Nav2** (Navigation 2) is the production-grade ROS 2 navigation framework — a collection of Action Servers and Lifecycle Nodes managing path planning, motor control, and recovery behaviors for autonomous robot navigation. It is **not** one program but a team of programs coordinated by a central **Behavior Tree**.

```
User Goal (coordinates)
       ↓
[Behavior Tree Manager]
  ├── [Global Planner]  → calculates full route from current position to goal
  ├── [Local Planner]   → generates real-time velocity commands to wheels
  └── [Recovery Behaviors] → handles stuck robot situations
```

Nav2 uses a **plugin architecture** — each component (path planner, obstacle avoider) is a swappable plugin. This allows Nav2 to power tiny 2-wheeled robots, robot dogs, and large industrial vehicles by swapping just the appropriate plugins.

**Why Action Servers instead of Services?** A ROS Service is synchronous (computer freezes until answer is returned). Navigating across a room takes 30+ seconds — using a Service would freeze all other processes. Action Servers are asynchronous: send a goal, receive periodic **Feedback** ("50% complete"), and a final **Result** ("Success" or "Failure") while the computer continues other work. **SLAM vs Nav2 distinction:** SLAM (e.g., slam_toolbox) builds the map. Nav2 uses the map to drive. Nav2 does not care how the map was made — it can navigate even a hand-drawn map.

A **Lifecycle Manager** in Nav2 ensures all sensors, maps, and planners boot in the exact correct order before allowing robot movement.

---

## Nav2 Costmaps

A **costmap** is a grid where each cell holds a numerical cost (0–254) representing how dangerous or difficult it is to drive through that area. **Inflation** artificially expands the danger zone around obstacles by assigning a gradient of decreasing cost outward from a lethal obstacle, creating a "force field" that pushes the robot toward the center of open spaces. **Inflation radius** is the distance from an obstacle out to which cost inflation extends — must be set at least equal to the robot's physical radius to prevent the robot body from touching walls.

Costmap cell values (0–255 byte scale):

| Value | Meaning |
|---|---|
| 0 | Free space — perfectly safe |
| 1–127 | Non-lethal cost — drivable but suboptimal |
| 128–252 | Possibly lethal depending on robot footprint |
| 253 | Inscribed inflated obstacle — robot center here = guaranteed body collision |
| 254 | Lethal obstacle — the physical wall itself |
| 255 | Unknown — no sensor data for this cell |

The 0–255 byte range means each cell fits in an 8-bit integer, making costmap processing highly memory-efficient.

**Global Costmap** is built once from the saved SLAM map and covers the entire known environment — used for long-distance route planning. **Local Costmap** is a small moving window (e.g., 3×3 meters) that travels with the robot and is updated continuously with live sensor data — handles dynamic obstacles (moving humans, dropped boxes) that the static global map cannot know about.

Three-layer costmap architecture: (1) **Static Layer** loads the saved SLAM map from disk, (2) **Obstacle Layer** subscribes to live `/scan` and `/camera` topics and paints new lethal costs dynamically, (3) **Inflation Layer** applies exponential decay outward from lethal costs up to `inflation_radius`.

**Misconception about inflation radius:** Setting inflation_radius to 3 meters in a 2-meter-wide hallway causes the entire hallway to be classified as too dangerous — the robot refuses to enter because there is no zero-cost path through the middle. Always ensure the inflation radius leaves a zero-cost corridor through standard doorways.

---

## Nav2 Path Planners

**NavFn** is the default global path planner plugin in Nav2. It uses the **A\* (A-Star)** or **Dijkstra** algorithm to find the shortest, safest path across the Global Costmap. A\* tracks three values per cell: `g(n)` = cost to reach cell n from start, `h(n)` = heuristic estimated cost from n to goal (straight-line distance), `f(n) = g(n) + h(n)` = total priority score (minimized). A\* guarantees the shortest path without exploring dead-ends unnecessarily. The global planner runs once when a new goal is received (or periodically to recalculate).

**DWB (Dynamic Window Approach)** is the default local planner controller plugin, running continuously at high frequency (~20 Hz). Every time step: (1) **Generate trajectories** — create a "fan" of possible short movement arcs within the robot's physical acceleration limits (the "Dynamic Window"), (2) **Score trajectories via Critics** — each arc is evaluated by Path Align Critic (does it stay on the global path?), Goal Align Critic (does it point toward the destination?), and Obstacle Critic (does it hit a wall in the local costmap?), (3) **Select the best** — highest-scoring arc becomes the velocity command sent to motors.

DWB scoring formula: `Total Score = (w1 × Path_Align) + (w2 × Goal_Align) + (w3 × Obstacle_Cost)` where w1, w2, w3 are tunable weights.

Global Planner vs Local Planner comparison:

| | Global Planner (NavFn) | Local Planner (DWB) |
|---|---|---|
| Role | Trip navigator | Real-time driver |
| Scope | Entire environment (Global Costmap) | Small window around robot (Local Costmap) |
| Runs | Once per goal | Continuously (~20 Hz) |
| Input | SLAM map + goal coordinates | Live sensor data + current velocity |
| Output | Full path (list of waypoints) | Velocity commands to motors |
| Algorithm | A\* or Dijkstra | Dynamic Window scoring with critics |

**Why does the robot "wiggle"?** If the Path Align Critic weight is too high, the robot obsessively corrects any tiny deviation from the global path, oscillating left-right. Balance the critic weights to fix this. DWB uses the robot's maximum acceleration limits to only generate trajectories the robot physically can execute in the next time step — a heavy forklift at 5 m/s cannot instantly turn 90°.

---

## ROS 2 Development Environment

**ROS 2** (Robot Operating System 2) is a collection of software libraries, tools, and conventions for building robot applications. Despite the name, it is NOT an operating system — it runs on top of Linux as a communication middleware layer. **Workspace** is a directory where all ROS 2 projects and packages are stored. **Sourcing** means running a setup script that adds ROS 2 tools to the current terminal session's PATH variable — without sourcing, the terminal does not recognize `ros2` commands. **colcon** is the build tool that compiles ROS 2 packages by reading metadata, resolving dependencies, and placing outputs in `install/`.

Workspace folder structure:
```
my_robot_ws/
├── src/       ← Your source code and packages (only edit here)
├── build/     ← Created by colcon (do not edit manually)
├── install/   ← Final built packages (do not edit manually)
└── log/       ← Build logs
```

Critical sourcing commands:
```bash
source /opt/ros/humble/setup.bash   # Sources system-wide ROS 2 (all tools)
source install/setup.bash           # Sources your workspace's built packages
# Both required, in that order; add both to ~/.bashrc to avoid sourcing every session
```

ROS 2 distributions: Humble Hawksbill (LTS, Ubuntu 22.04, supported until 2027, most widely adopted), Iron Irwini (Standard, Ubuntu 22.04), Jazzy Jalisco (Latest LTS, Ubuntu 24.04).

What `colcon build` does: (1) reads `package.xml` to determine build order and dependencies, (2) reads `setup.py` or `CMakeLists.txt` for build instructions, (3) compiles and installs into `install/`, (4) creates shell hooks so `ros2 run` can find executables. The `--symlink-install` flag creates symbolic links for Python files so changes are reflected immediately without rebuilding. `ros2 doctor` checks ROS 2 environment health. `printenv | grep ROS` should show `ROS_DISTRO=humble`, `ROS_VERSION=2`.

---

## ROS 2 Packages

A **package** is the fundamental organizational unit of ROS 2 — a directory containing robot code, configuration, and metadata in a standardized structure. `package.xml` is the package's "ID card": it declares name, version, maintainer, license, and all build/runtime dependencies. `setup.py` contains installation instructions for Python packages; its `entry_points` section maps `ros2 run` command names to Python functions. `CMakeLists.txt` is the build instruction file for C++ packages.

`ament_python` is the build type for Python-based packages; `ament_cmake` is for C++ packages and is also required for interface packages (holding `.msg` or `.srv` files) regardless of whether other code uses Python — because generating C++ and Python code from interface files requires the CMake build system. A **node** is a single executable process performing a specific task and communicating via topics, services, or actions.

Python package structure:
```
my_package/
├── package.xml          ← metadata (name, version, dependencies)
├── setup.py             ← install instructions + entry_points
├── setup.cfg            ← entry point configuration
├── resource/
│   └── my_package       ← empty marker file (required by ROS 2 ament index)
└── my_package/
    ├── __init__.py      ← makes it a Python module
    └── my_node.py       ← your actual code
```

Creating packages: `ros2 pkg create --build-type ament_python my_package` (Python) or `ros2 pkg create --build-type ament_cmake my_package` (C++). Just creating a folder is NOT sufficient — ROS 2 will not recognize it as a package without `package.xml` and proper structure.

`package.xml` structure example:
```xml
<?xml version="1.0"?>
<package format="3">
  <name>my_package</name>
  <version>0.0.1</version>
  <description>My first ROS 2 package</description>
  <maintainer email="you@email.com">Your Name</maintainer>
  <license>Apache-2.0</license>
  <buildtool_depend>ament_python</buildtool_depend>
  <exec_depend>rclpy</exec_depend>
  <exec_depend>std_msgs</exec_depend>
  <export><build_type>ament_python</build_type></export>
</package>
```

`setup.py` entry points map `ros2 run` commands to Python functions:
```python
entry_points={
    'console_scripts': [
        'my_node = my_package.my_node:main',
        # 'executable_name = package_name.module_name:function_name'
    ],
},
```
`package.xml` tells ROS 2 about the package (metadata, dependencies); `setup.py` tells Python how to install it. Both are required for Python packages and serve different purposes. After creating a new node, always run `colcon build` then `source install/setup.bash` before using it.

---

## ROS 2 Publisher and Subscriber Nodes

A **topic** is a named communication channel through which nodes exchange messages asynchronously. A **publisher** sends messages to a topic; a **subscriber** receives them. A **message** is a strongly-typed data structure defined in `.msg` files. **rclpy** is the ROS 2 Client Library for Python — every Python node starts with `import rclpy`. A **callback function** is automatically called when a new message arrives on a subscribed topic. **QoS (Quality of Service)** controls message delivery: reliability, durability, and history depth.

Publisher and subscriber are **completely decoupled** — neither knows about the other, only about the topic name and message type. A publisher runs even with zero subscribers (messages go into the void — nothing breaks). Multiple publishers can publish to the same topic. Multiple subscribers can subscribe to the same topic. If the subscriber is slower than the publisher, older messages are **dropped** when the queue fills (queue depth set by `depth` QoS parameter).

Common message types:

| Package | Type | Fields | Used For |
|---|---|---|---|
| `std_msgs` | `String` | `data: string` | Text messages |
| `std_msgs` | `Int32` | `data: int32` | Integer values |
| `std_msgs` | `Float64` | `data: float64` | Floating point |
| `geometry_msgs` | `Twist` | `linear`, `angular` | Velocity commands |
| `sensor_msgs` | `LaserScan` | `ranges`, `angle_min`, etc. | LiDAR data |
| `sensor_msgs` | `Image` | `data`, `height`, `width` | Camera frames |

Node lifecycle (mandatory sequence):
```
rclpy.init()          ← Initialize ROS 2 communication
node = MyNode()       ← Create node; registers publishers/subscribers
rclpy.spin(node)      ← Keep running; process callbacks on message arrival
node.destroy_node()   ← Clean up resources (after Ctrl+C)
rclpy.shutdown()      ← Shut down ROS 2 communication
```

`rclpy.spin()` is critical: without it, the node starts and immediately exits before receiving any messages. `spin()` keeps the node alive and processes callbacks. Timer frequency: `create_timer(0.5, callback)` = 2 Hz; `create_timer(1.0, callback)` = 1 Hz (period = 1/frequency).

Minimal publisher node:
```python
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

class MinimalPublisher(Node):
    def __init__(self):
        super().__init__('minimal_publisher')
        self.publisher_ = self.create_publisher(String, 'chatter', 10)  # queue depth 10
        self.timer = self.create_timer(1.0, self.timer_callback)         # 1 Hz
        self.i = 0

    def timer_callback(self):
        msg = String()
        msg.data = f'Hello World: {self.i}'
        self.publisher_.publish(msg)
        self.i += 1

def main(args=None):
    rclpy.init(args=args)
    node = MinimalPublisher()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()
```

Minimal subscriber node:
```python
class MinimalSubscriber(Node):
    def __init__(self):
        super().__init__('minimal_subscriber')
        self.subscription = self.create_subscription(
            String, 'chatter', self.listener_callback, 10)

    def listener_callback(self, msg):
        self.get_logger().info(f'I heard: "{msg.data}"')
```

Subscriber troubleshooting checklist: (1) Are publisher and subscriber using the same topic name? (case-sensitive), (2) Are they using the same message type?, (3) Is `rclpy.spin()` being called?, (4) Was the workspace sourced before running? ROS 2 uses **DDS (Data Distribution Service)** as communication middleware — subscribers on the same topic, same `ROS_DOMAIN_ID`, and compatible QoS settings receive messages.

---

## ROS 2 Services

A **service** is a ROS 2 communication pattern for request-response interactions — one node sends a request, another processes it and sends a response. Services are point-to-point (one client to one server per call), unlike topics which are one-to-many. A **service server** receives requests and sends responses (the "handler"). A **service client** sends requests and receives responses (the "requester"). A **`.srv` file** defines the data structure for both request and response, separated by three dashes (`---`).

`.srv` file format:
```
# REQUEST section
int64 a
int64 b
---              ← exactly three dashes separate request from response
# RESPONSE section
int64 sum
```

When to use Topics vs Services:

| Use **Topic** when... | Use **Service** when... |
|---|---|
| Data flows continuously | A specific answer is needed |
| No confirmation needed | Confirmation of success is needed |
| Multiple nodes need the data | One node needs the response |
| Sensor data (time-stamped) | One-time computation or command |

Interface packages holding `.msg` and `.srv` files always use `ament_cmake` (not `ament_python`) because generating C++ and Python code from interface files requires the CMake build system. Interface packages must be built **before** any node packages that use them. Verify: `ros2 interface show my_interfaces/srv/AddTwoInts`.

Service server pattern:
```python
class AddTwoIntsServer(Node):
    def __init__(self):
        super().__init__('add_two_ints_server')
        self.srv = self.create_service(
            AddTwoInts, 'add_two_ints', self.add_two_ints_callback)

    def add_two_ints_callback(self, request, response):
        response.sum = request.a + request.b
        return response  # MUST return the response object
```

Service client pattern (asynchronous call):
```python
self.client = self.create_client(AddTwoInts, 'add_two_ints')
while not self.client.wait_for_service(timeout_sec=1.0):
    self.get_logger().info('Waiting for service...')
future = self.client.call_async(self.req)
rclpy.spin_until_future_complete(self, self.future)
response = future.result()
```

CLI service call: `ros2 service call /add_two_ints my_interfaces/srv/AddTwoInts "{a: 7, b: 8}"`. `ros2 service list` shows all currently available services. Only one server should handle a given service name — multiple servers for the same name causes undefined behavior. The server callback function **must** return the response object or the client hangs indefinitely. `wait_for_service()` prevents the client from sending a request before the server is ready.

---

## ROS 2 Launch Files and CLI Tools

A **launch file** is a Python script (`.launch.py`) that starts multiple ROS 2 nodes simultaneously, configures them with parameters, sets up topic remappings, and accepts runtime arguments. Without launch files, running a complete robot requires opening many terminals and running `ros2 run` in each one in the correct order.

Minimal launch file structure:
```python
from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
    return LaunchDescription([
        Node(
            package='my_package',
            executable='my_node',
            name='my_node_renamed',          # optional rename
            parameters=[{'param_name': 'value'}],
            remappings=[('/old_topic', '/new_topic')],
            output='screen',                  # show logs in terminal
        ),
    ])
```

Launch files with arguments (runtime configuration):
```python
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration

DeclareLaunchArgument('robot_name', default_value='my_robot')
# Access as: LaunchConfiguration('robot_name')
# Run with: ros2 launch my_package file.launch.py robot_name:=bot2
```

Launch files use Python (not shell scripts) — enabling conditionals, loops, and logic. The `launch/` directory must be declared in `setup.py` `data_files` to be installed. `remappings` redirect topic names without changing node source code — useful for integrating third-party nodes that use different topic name conventions.

Essential CLI inspection commands:

| Command | Purpose |
|---|---|
| `ros2 node list` | List all running nodes |
| `ros2 node info /node_name` | Show node's topics, services, parameters |
| `ros2 topic list` | List all active topics |
| `ros2 topic echo /topic` | Print messages in real-time |
| `ros2 topic hz /topic` | Measure publishing frequency |
| `ros2 topic pub /topic type "{data: 'hello'}"` | Publish manually from CLI |
| `ros2 service list` | List all available services |
| `ros2 service call /service type "{field: value}"` | Call service from CLI |
| `ros2 interface show std_msgs/msg/String` | Show message structure |
| `ros2 param list` | List all parameters for all nodes |
| `ros2 param get /node param` | Get a specific parameter value |
| `rqt_graph` | GUI graph of nodes and topics |

**TF2** (Transform Library 2) tracks the position and orientation of every coordinate frame in the robot system over time. `robot_state_publisher` computes and broadcasts all TF transforms from the URDF and current joint states. TF2 stores transform history, enabling queries like "where was frame X relative to frame Y, 2 seconds ago?" Every sensor plugin must have a properly defined TF frame (link in URDF) for its data to be correctly interpreted by navigation systems. TF inspection: `ros2 run tf2_tools view_frames` (generates a PDF of the complete TF tree); `ros2 run tf2_ros tf2_echo base_link camera_link` (prints live transform between two frames).

---

## Cross-Topic Summary: Tools, Patterns, and Comparisons

**Tool quick reference:**

| Tool | Type | Primary Purpose |
|---|---|---|
| Gazebo | Physics Simulator | Generate sensor data; enforce physics |
| RViz | Visualizer | Display robot model, TF frames, sensor data |
| slam_toolbox | SLAM Algorithm | Build Occupancy Grid maps in real-time |
| Nav2 | Navigation Framework | Autonomous point-to-point movement |
| robot_state_publisher | ROS Node | Broadcasts TF tree from URDF + joint states |
| joint_state_publisher | ROS Node | Tracks and broadcasts joint positions |
| colcon | Build Tool | Compiles ROS 2 packages |

**ROS 2 communication pattern selection:**

| Pattern | Direction | Response | Best For |
|---|---|---|---|
| Topic (Pub-Sub) | One-to-many | None | Continuous data streams (sensors, state) |
| Service | One-to-one | Yes (synchronous) | Discrete queries, one-time actions |
| Action | One-to-one | Yes (async + feedback) | Long-running tasks (navigation goals) |

**Key file types in a ROS 2 project:**

| File | Purpose | Build Type |
|---|---|---|
| `package.xml` | Package metadata and dependencies | Both |
| `setup.py` | Python install instructions + entry points | `ament_python` |
| `CMakeLists.txt` | C++ build instructions | `ament_cmake` |
| `.msg` | Custom message type definition | Interface package |
| `.srv` | Custom service type definition | Interface package |
| `.launch.py` | Multi-node startup script | Any |
| `.xacro` / `.urdf.xacro` | Macro-enhanced robot model | Preprocessed to URDF |

**Differential drive equations summary:**

| Quantity | Formula |
|---|---|
| Wheel ground speed | $v_{R,L} = r \cdot \omega_{R,L}$ |
| Robot linear velocity | $v = (v_R + v_L) / 2$ |
| Robot angular velocity | $\omega = (v_R - v_L) / L$ |
| Spin in place condition | $v_R = -v_L$ |

**Costmap value reference:** 0 = free, 1–127 = non-lethal, 128–252 = possibly lethal, 253 = inscribed (body collision guaranteed), 254 = lethal obstacle (wall), 255 = unknown.
