// BTC bot head: a robot-head case for a Raspberry Pi 5 + Sense HAT (no GPIO riser).
// The Sense HAT's 8x8 LED matrix is the mouth and shines through a thin skin of white PETG.
//
// The head stands upright: USB/Ethernet on top, USB-C + micro-HDMI on its left side (your right
// when you face it), microSD and power button underneath (lift the head off the base to reach them).
//
// Parts (set PART, or use the STLs):
//   "face"   front shell: face, mouth grid, eyes, ears, side walls   - print face DOWN
//   "back"   back tray the Pi sits in                                - print back DOWN
//   "base"   neck/shoulders stand                                   - print as shown
//   "coupon" small test piece of the mouth: hold it on the LEDs to check the grid lines up
//   "all"    assembled preview (with ghost boards)
//
// Coordinates: the Pi 5's own drawing. x along the 85 mm edge (0 = microSD end), y along the 56 mm
// edge (0 = USB-C/HDMI edge), z up from the top of the Pi's circuit board. In the head, +x is "up".
// Dimensions: Raspberry Pi 5 mechanical drawing, Sense HAT product brief (both Raspberry Pi Ltd).

PART = "all";

/* [Stack: measure these if the fit is off] */
hat_gap   = 11.0;  // Pi board top -> Sense HAT board bottom (11 = header fully seated, no riser)
pcb       = 1.6;   // board thickness (Pi and HAT)
led_h     = 1.4;   // LED package height above the HAT board
usb_h     = 16.0;  // USB stack height above the Pi board
grid_gap  = 0.6;   // air gap between LED tops and the mouth grid

/* [Mouth: Sense HAT LED grid] */
led_x0    = 6.98;  // first LED column, left edge (Pi x)
led_pitch_x = 4.0; // along the Pi's long edge (8 columns)
led_y_top = 45.14; // top edge of the top LED row (Pi y; HAT is 56.5 tall, rows run toward y=0)
led_pitch_y = 4.45;
led_w_x   = 3.5;   // LED size
led_w_y   = 3.35;
skin      = 0.6;   // diffuser thickness over the LEDs (3 layers at 0.2 mm)
grid_wall_x = 0.6; // grid walls between columns
grid_wall_y = 0.9; // grid walls between rows

/* [Case] */
wall   = 2.4;
face_t = 2.4;      // face plate thickness
back_gap = 5.0;    // room under the Pi board
corner_r = 6;
chamfer  = 1.5;
eye_d    = 9;      // eye holes (the right one is over the joystick)
screw_pilot = 2.6; // M3 self-tapping into PETG
screw_clear = 3.4;
screw_head  = 6.4;
$fn = 48;

// ---------------------------------------------------------------- derived
hat_bot  = hat_gap;
hat_top  = hat_gap + pcb;
led_top  = hat_top + led_h;
face_in  = max(usb_h + 0.8, led_top + 3.0);   // inside of the face plate
face_out = face_in + face_t;
back_in  = -pcb - back_gap;
back_out = back_in - wall;
split    = -pcb - 0.2;                          // front shell / back tray joint, just under the Pi

// outer box (Pi coordinates)
X0 = -3.4;  X1 = 88.0;           // microSD end .. port faces (ports stick out 3 mm, flush with the wall)
Y0 = -4.75; Y1 = 61.25;          // centred on the mouth (y = 28.25)
YC = (Y0 + Y1) / 2;
IX0 = X0 + wall; IX1 = X1 - wall; IY0 = Y0 + wall; IY1 = Y1 - wall;

holes = [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]];   // Pi and HAT mounting holes
joy   = [53.4, 7.5];                                              // Sense HAT joystick
eyes  = [joy, [joy[0], 2 * YC - joy[1]]];
ears  = [[60, Y0 - 1.25], [60, Y1 + 1.25]];
ear_r = 8;

// LED grid in Pi coordinates
mouth_x0 = led_x0 - grid_wall_x / 2 - 0.6;
mouth_x1 = led_x0 + 7 * led_pitch_x + led_w_x + grid_wall_x / 2 + 0.6;
mouth_y1 = led_y_top + grid_wall_y / 2 + 0.6;
mouth_y0 = led_y_top - 7 * led_pitch_y - led_w_y - grid_wall_y / 2 - 0.6;

// ---------------------------------------------------------------- helpers
module rrect(x0, y0, x1, y1, r) {
  hull() for (x = [x0 + r, x1 - r], y = [y0 + r, y1 - r]) translate([x, y]) circle(r = r);
}
// rounded box with 45-degree chamfers on the top and bottom edges
module cbox(x0, y0, x1, y1, z0, z1, r, c) {
  hull() {
    translate([0, 0, z0]) linear_extrude(0.01) rrect(x0 + c, y0 + c, x1 - c, y1 - c, r - c);
    translate([0, 0, z0 + c]) linear_extrude(z1 - z0 - 2 * c) rrect(x0, y0, x1, y1, r);
    translate([0, 0, z1 - 0.01]) linear_extrude(0.01) rrect(x0 + c, y0 + c, x1 - c, y1 - c, r - c);
  }
}
module ear_solid(p, z0, z1) {
  translate([p[0], p[1], z0]) hull() {
    cylinder(r = ear_r - chamfer, h = 0.01);
    translate([0, 0, chamfer]) cylinder(r = ear_r, h = z1 - z0 - 2 * chamfer);
    translate([0, 0, z1 - z0 - 0.01]) cylinder(r = ear_r - chamfer, h = 0.01);
  }
}
module shell_solid() {
  cbox(X0, Y0, X1, Y1, back_out, face_out, corner_r, chamfer);
  for (e = ears) ear_solid(e, back_out, face_out);
}
module cavity() {
  translate([0, 0, back_in]) linear_extrude(face_in - back_in) rrect(IX0, IY0, IX1, IY1, corner_r - wall);
}
// a box given by its two corners
module box(a, b) { translate(a) cube([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); }

// everything that goes through the walls (also cut from the back tray and its lip)
module port_cuts() {
  z0 = back_in + 0.01;
  // underneath: microSD, power button, status LED
  box([X0 - 1, 21.5, -4.4], [-0.1, 35.0, -0.6]);
  box([X0 - 1, 16.2, split - 0.01], [-0.1, 20.6, 3.2]);
  box([X0 - 1, 11.8, split - 0.01], [-0.1, 14.8, 2.6]);
  // left side (y = 0 edge): USB-C, then both micro-HDMI in one slot
  box([11.2 - 6.6, Y0 - 1, -2.9], [11.2 + 6.6, -0.15, 6.0]);
  box([19.6, Y0 - 1, -2.9], [45.4, -0.15, 6.2]);
  // top: Ethernet, USB, USB
  box([IX1 - 0.6, 1.6, split - 0.01], [X1 + 1, 19.1, 14.4]);
  box([IX1 - 0.6, 21.4, split - 0.01], [X1 + 1, 36.9, usb_h + 0.6]);
  box([IX1 - 0.6, 39.2, split - 0.01], [X1 + 1, 55.1, usb_h + 0.6]);
}
// air: slots in both side walls (above the ear) and across the back
module vents() {
  for (x = [70, 74.5, 79]) for (y = [Y0 - 1, IY1 - 0.5]) box([x, y, 1.5], [x + 2.2, y + wall + 1.5, face_in - 4]);
  for (y = [6:4.2:50]) translate([10, y, back_out - 1]) cube([46, 2, wall + 2]);
}

// ---------------------------------------------------------------- front shell
module mouth_grid() {
  // the grid hangs from the inside of the skin down to just above the LEDs
  zb = led_top + grid_gap;
  zt = face_out - skin;
  difference() {
    box([mouth_x0, mouth_y0, zb], [mouth_x1, mouth_y1, zt + 0.01]);
    for (i = [0:7], j = [0:7]) {
      cx = led_x0 + i * led_pitch_x + led_w_x / 2;
      cy = led_y_top - j * led_pitch_y - led_w_y / 2;
      box([cx - (led_pitch_x - grid_wall_x) / 2, cy - (led_pitch_y - grid_wall_y) / 2, zb - 1],
          [cx + (led_pitch_x - grid_wall_x) / 2, cy + (led_pitch_y - grid_wall_y) / 2, zt + 1]);
    }
  }
}
module face_details() {
  // debossed into the face (they print on the bed side, no supports)
  d = 0.7;
  translate([0, 0, face_out - d]) linear_extrude(d + 1) {
    // eye sockets
    for (e = eyes) translate(e) difference() { circle(d = 17); circle(d = 13); }
    // ear bolts
    for (e = ears) translate(e) difference() { circle(d = 10); circle(d = 6.5); }
    // lips around the mouth
    difference() {
      rrect(mouth_x0 - 3.2, mouth_y0 - 3.2, mouth_x1 + 3.2, mouth_y1 + 3.2, 4);
      rrect(mouth_x0 - 2.0, mouth_y0 - 2.0, mouth_x1 + 2.0, mouth_y1 + 2.0, 3);
    }
    // forehead: reads upright when the head stands (x is up)
    translate([75.5, YC]) rotate(-90) text("BTC BOT", size = 6.2, font = "Liberation Sans:style=Bold", halign = "center", valign = "center");
  }
}
module front_posts() {
  // press on the HAT's corners and locate it by its holes
  for (h = holes) translate([h[0], h[1], 0]) {
    translate([0, 0, hat_top + 0.15]) cylinder(d = 5.4, h = face_in - hat_top - 0.1);
    translate([0, 0, hat_bot + 0.3]) cylinder(d = 2.3, h = pcb + 0.2);
  }
}
module face_shell() {
  difference() {
    union() {
      difference() {
        intersection() { shell_solid(); box([-50, -50, split], [150, 150, 50]); }
        cavity();
      }
      front_posts();
      mouth_grid();
    }
    // the mouth window: leave only the skin over the LEDs
    box([mouth_x0, mouth_y0, face_in - 1], [mouth_x1, mouth_y1, face_out - skin]);
    for (e = eyes) translate([e[0], e[1], face_in - 10]) cylinder(d = eye_d, h = 20);
    for (e = ears) translate([e[0], e[1], split - 1]) cylinder(d = screw_pilot, h = face_in - split - 1);
    port_cuts();
    vents();
    face_details();
  }
  // the grid itself, added back after the window cut
  intersection() { mouth_grid(); box([-50, -50, split], [150, 150, face_out - skin + 0.001]); }
}

// ---------------------------------------------------------------- back tray
module back_tray() {
  difference() {
    union() {
      difference() {
        intersection() { shell_solid(); box([-50, -50, back_out - 1], [150, 150, split]); }
        cavity();
      }
      // posts the Pi sits on, with pins into its holes
      for (h = holes) translate([h[0], h[1], 0]) {
        translate([0, 0, back_in - 0.01]) cylinder(d = 6, h = -pcb - back_in);
        translate([0, 0, -pcb - 0.01]) cylinder(d = 2.3, h = pcb - 0.3);
      }
      // alignment lip that slips inside the front shell (bottom and both sides, not the port end)
      intersection() {
        difference() {
          translate([0, 0, split - 0.01]) linear_extrude(2.0) rrect(IX0 + 0.25, IY0 + 0.25, IX1 - 0.25, IY1 - 0.25, corner_r - wall - 0.25);
          translate([0, 0, split - 1]) linear_extrude(4) rrect(IX0 + 0.85, IY0 + 1.05, IX1 + 5, IY1 - 1.05, 1);
        }
        box([-50, -50, -50], [78, 150, 50]);
      }
    }
    port_cuts();
    vents();
    for (e = ears) translate([e[0], e[1], back_out - 1]) {
      cylinder(d = screw_clear, h = 20);
      cylinder(d = screw_head, h = 1 + 3.2);
    }
  }
}

// ---------------------------------------------------------------- base (neck + shoulders)
base_h = 12; pocket = 6; base_w = 96; base_d = 50;
module base() {
  // in its own frame: z up, the head's footprint (y, z of the head) becomes (x, y) here
  hy0 = Y0; hy1 = Y1; hz0 = back_out; hz1 = face_out;
  cx = (hy0 + hy1) / 2; cy = (hz0 + hz1) / 2;
  difference() {
    translate([cx, cy, 0]) cbox(-base_w / 2, -base_d / 2, base_w / 2, base_d / 2, 0, base_h, 10, 2);
    // pocket the head sits in
    translate([0, 0, base_h - pocket]) linear_extrude(pocket + 1) offset(r = 0.35) rrect(hy0, hz0, hy1, hz1, 1.5);
    // the ear screws' counterbores are above the pocket; nothing else to clear
    // collar grooves on the front
    for (k = [0:2]) translate([cx - 28, cy + base_d / 2 - 0.8, 2.6 + k * 2.6]) cube([56, 2, 1.1]);
    // finger notch at the back, to lift the head out
    translate([cx, hz0 - 1, base_h]) rotate([-90, 0, 0]) cylinder(d = 16, h = 6);
  }
}

// ---------------------------------------------------------------- test coupon
module coupon() {
  difference() {
  intersection() {
    face_shell();
    box([mouth_x0 - 5, mouth_y0 - 5, split], [mouth_x1 + 5, mouth_y1 + 5, 60]);
  }
  // (the corner posts are left off so it sits on the LED grid alone)
  for (h = holes) translate([h[0], h[1], split - 1]) cylinder(d = 6.5, h = face_in - split + 1);
  }
}

// ---------------------------------------------------------------- ghost boards (preview only)
module ghosts() {
  %translate([0, 0, -pcb]) linear_extrude(pcb) rrect(0, 0, 85, 56, 3);
  %translate([0, 0, hat_bot]) linear_extrude(pcb) rrect(0, 0, 65, 56.5, 3);
  color("gold") for (i = [0:7], j = [0:7]) translate([led_x0 + i * led_pitch_x, led_y_top - j * led_pitch_y - led_w_y, hat_top]) cube([led_w_x, led_w_y, led_h]);
  color("silver") { translate([65, 22, 0]) cube([23, 14.3, usb_h]); translate([65, 39.8, 0]) cube([23, 14.6, usb_h]); translate([66.8, 2.3, 0]) cube([21.2, 16.1, 13.5]); }
}


// ---------------------------------------------------------------- previews (standing up, facing you)
module stand() { multmatrix([[0, -1, 0, 0], [0, 0, -1, 0], [1, 0, 0, 0], [0, 0, 0, 1]]) children(); }
module boards() {
  color([0.1, 0.45, 0.2]) translate([0, 0, -pcb]) linear_extrude(pcb) rrect(0, 0, 85, 56, 3);
  color([0.1, 0.4, 0.25]) translate([0, 0, hat_bot]) linear_extrude(pcb) rrect(0, 0, 65, 56.5, 3);
  for (i = [0:7], j = [0:7]) color([(i + j) % 3 == 0 ? 1 : 0.2, (i * j) % 2 ? 0.9 : 0.3, j > 4 ? 1 : 0.3])
    translate([led_x0 + i * led_pitch_x, led_y_top - j * led_pitch_y - led_w_y, hat_top]) cube([led_w_x, led_w_y, led_h]);
  color("silver") { translate([65, 22, 0]) cube([23, 14.3, usb_h]); translate([65, 39.8, 0]) cube([23, 14.6, usb_h]); translate([66.8, 2.3, 0]) cube([21.2, 16.1, 13.5]); }
  color("dimgray") translate([7.1, 51.4, 0]) cube([50.8, 2.2, hat_gap]);
  color("black") translate([joy[0], joy[1], hat_top]) cylinder(d = 3, h = 4.5);
}

// ---------------------------------------------------------------- output
// print orientations: face down, back down, base as is
if (PART == "face") translate([0, 0, face_out]) rotate([0, 180, 0]) face_shell();
else if (PART == "back") translate([0, 0, -back_out]) back_tray();
else if (PART == "base") base();
else if (PART == "coupon") translate([0, 0, face_out]) rotate([0, 180, 0]) coupon();
else if (PART == "assembled") { face_shell(); back_tray(); }
else if (PART == "face_pi") face_shell();
else if (PART == "back_pi") back_tray();
else if (PART == "show") {
  translate([0, 0, base_h - pocket - X0]) stand() { color([0.96, 0.96, 0.94]) face_shell(); color([0.9, 0.9, 0.88]) back_tray(); }
  color([0.93, 0.93, 0.91]) rotate([0, 0, 180]) base();
}
else if (PART == "exploded") {
  translate([0, 0, base_h - pocket - X0 + 30]) stand() {
    color([0.96, 0.96, 0.94]) translate([0, 0, 40]) face_shell();
    boards();
    color([0.88, 0.88, 0.86]) translate([0, 0, -30]) back_tray();
  }
  color([0.93, 0.93, 0.91]) rotate([0, 0, 180]) base();
}
else { color("white") face_shell(); color("whitesmoke") back_tray(); ghosts(); }
