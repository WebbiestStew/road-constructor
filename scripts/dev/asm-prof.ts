import { REAL_CITY_DATA } from "../../src/sim/real/all";
import { assembleNetwork } from "../../src/sim/network";
const net = REAL_CITY_DATA["lincoln-tunnel"].network;
for (let i = 0; i < 6; i++) assembleNetwork(net);
