import { box, merge, panel, sectionAt, shell, wheels, hubs } from './vehicle-geometry.js';

const AXLES = Object.freeze([1.4, -1.4]);
const WHEEL_Y = 0.34;
// Rolling radius is axle-to-road distance, not the slightly larger tread
// circumradius that gives the twelve-sided tire a flat contact face.
export const PASSENGER_WHEELS = Object.freeze({ axles: AXLES, y: WHEEL_Y, radius: WHEEL_Y });

const BODY = [
  [{z:2.28,hw:.72,y0:.4,y1:.71},{z:2.05,hw:.9,y0:.3,y1:.8},{z:.95,hw:.95,y0:.28,y1:.98},{z:-1.55,hw:.95,y0:.28,y1:1.02},{z:-2.08,hw:.88,y0:.32,y1:.94},{z:-2.28,hw:.72,y0:.4,y1:.82}],
  [{z:2.17,hw:.74,y0:.4,y1:.74},{z:1.98,hw:.91,y0:.3,y1:.82},{z:1.05,hw:.95,y0:.28,y1:1.02},{z:-1.95,hw:.95,y0:.28,y1:1.06},{z:-2.17,hw:.84,y0:.38,y1:1.0}],
];
const CABIN = [
  [{z:.98,hw:.78,y0:.94,y1:.99},{z:.3,hw:.7,y0:.96,y1:1.46},{z:-.75,hw:.7,y0:.98,y1:1.44},{z:-1.6,hw:.76,y0:1.0,y1:1.025}],
  [{z:1.02,hw:.8,y0:.99,y1:1.04},{z:.35,hw:.73,y0:1.0,y1:1.5},{z:-1.35,hw:.73,y0:1.02,y1:1.48},{z:-2.05,hw:.78,y0:1.04,y1:1.08}],
];
export const PASSENGER_LIGHTS = [false,true].map(hatch => ({
  rear:hatch?-2.184:-2.294,front:hatch?2.184:2.294,halfW:.53,y:hatch?.65:.55,
  brakeZ:hatch?-2.188:-2.298,brakeY:hatch?.87:.74,brakeHalfW:.53,brakeW:.3,brakeH:.1,brakeDepth:.008,
  blinkZR:hatch?-2.188:-2.298,blinkYR:hatch?.65:.55,blinkHalfWR:.53,blinkWR:.27,blinkHR:.07,blinkDepthR:.008,
  blinkZF:hatch?2.188:2.298,blinkYF:.46,blinkHalfWF:.53,blinkWF:.27,blinkHF:.07,blinkDepthF:.008,
}));
export function buildPassengerGeometry(hatch=false) {
  const style=hatch?1:0, cabin=CABIN[style], front=hatch?2.17:2.28, rear=-front;
  const body=[shell(BODY[style],AXLES,WHEEL_Y),shell(cabin)];
  const glass=[];
  // Inset windscreens leave painted A/C pillars and a roof lip.
  for (const [za,zb] of [[cabin[0].z-.055,cabin[1].z+.04],[cabin[2].z-.04,cabin[3].z+.055]]) {
    const a=sectionAt(cabin,za),b=sectionAt(cabin,zb);
    glass.push(panel([[-a.hw+.075,a.y1+.009,za],[a.hw-.075,a.y1+.009,za],[b.hw-.075,b.y1+.009,zb],[-b.hw+.075,b.y1+.009,zb]],[0,1,0]));
  }
  for(const side of [-1,1]) {
    for(const [za,zb] of [[cabin[0].z-.15,-.22],[-.31,cabin[3].z+.17]]) {
      const stations=[za,...cabin.map(s=>s.z).filter(z=>z<za&&z>zb),zb];
      for (let i=0;i<stations.length-1;i++) {
        const z0=stations[i],z1=stations[i+1],a=sectionAt(cabin,z0),b=sectionAt(cabin,z1);
        glass.push(panel([
          [side*(a.hw+.009),Math.max(a.y0+.055,a.y1-.055),z0],
          [side*(b.hw+.009),Math.max(b.y0+.055,b.y1-.055),z1],
          [side*(b.hw+.009),b.y0+.045,z1],[side*(a.hw+.009),a.y0+.045,z0],
        ],[side,0,0]));
      }
    }
  }
  const trim=[box(1.5,.12,.085,0,.39,front-.045),box(1.52,.13,.085,0,.39,rear+.045),box(.61,.12,.014,0,.62,front+.009),box(.5,.16,.018,0,.55,rear-.009)];
  for(const side of [-1,1]) {
    trim.push(box(.075,.105,1.9,side*.956,.32,0),box(.17,.105,.25,side*1.0,1.035,.7));
    for(const z of [.1,-.83]) trim.push(box(.021,.035,.2,side*.961,.89,z));
    trim.push(box(.012,.53,.016,side*.962,.64,-.27));
  }
  const frontLens=[-1,1].map(side=>box(.32,.12,.014,side*.53,hatch?.65:.63,front+.01));
  const rearLens=[-1,1].map(side=>box(.32,.12,.014,side*.53,hatch?.87:.74,rear-.01));
  const indicators=[];
  for(const side of [-1,1])for(const [z,y] of [[front+.01,.46],[rear-.01,hatch?.65:.55]])indicators.push(box(.29,.09,.014,side*.53,y,z));
  return {body:merge(body),glass:merge(glass),trim:merge(trim),frontLens:merge(frontLens),rearLens:merge(rearLens),indicators:merge(indicators)};
}
const SPOTS=AXLES.flatMap(z=>[[.84,z],[-.84,z]]);
export const buildPassengerWheels=()=>({wheels:wheels(SPOTS,WHEEL_Y,.26),hubs:hubs(SPOTS,WHEEL_Y,.26)});
