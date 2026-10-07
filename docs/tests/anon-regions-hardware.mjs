import { NodeJSSerialConnection, Constants, BufferUtils } from "../../src/index.js";

// Manual hardware validation for anonymous repeater region discovery.
// Usage:
//   node docs/tests/anon-regions-hardware.mjs unsupported [serial-port] [repeater-public-key-hex]
//   node docs/tests/anon-regions-hardware.mjs supported   [serial-port] [repeater-public-key-hex]
//
// The supported mode sends a radio request. If the repeater is not already in
// the contact table, it temporarily adds a direct contact and removes it after
// the check. The script is intentionally not wired into the automated test
// command because it requires a physical Companion and a reachable repeater.

const mode = process.argv[2];
if(mode !== "supported" && mode !== "unsupported") {
    throw new Error("Pass supported or unsupported. See the usage comment at the top of this file.");
}

const serialPort = process.argv[3] ?? "COM4";
const repeaterPublicKeyHex = process.argv[4] ?? "e85c3af54fd3d88e41c559093d0b04a4294e489725bbd79ee96fd9d542219a40";
const repeaterPublicKey = BufferUtils.hexToBytes(repeaterPublicKeyHex);
if(repeaterPublicKey.length !== 32) {
    throw new Error("Repeater public key must be exactly 32 bytes (64 hexadecimal characters).");
}

const expectedRegions = ["*", "us-oh", "cvg", "us-midwest", "oki", "day"];
const connection = new NodeJSSerialConnection(serialPort);
let connected = false;
let addedTemporaryContact = false;

try {
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${serialPort} connection.`)), 15000);
        connection.on("connected", () => {
            clearTimeout(timeout);
            connected = true;
            resolve();
        });
        connection.connect().catch((error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });

    const deviceInfo = await connection.deviceQuery(Constants.SupportedCompanionProtocolVersion);
    console.log("Companion DeviceInfo:", JSON.stringify({
        firmwareVer: deviceInfo.firmwareVer,
        firmware_build_date: deviceInfo.firmware_build_date,
        manufacturerModel: deviceInfo.manufacturerModel,
    }));

    if(mode === "unsupported") {
        try {
            await connection.getRegions(repeaterPublicKey);
            throw new Error("Expected UnsupportedCmd, but getRegions() succeeded.");
        } catch(error) {
            if(error.errCode !== Constants.ErrorCodes.UnsupportedCmd) {
                throw new Error(`Expected UnsupportedCmd (${Constants.ErrorCodes.UnsupportedCmd}); got ${error.errCode ?? error.message}.`);
            }
            console.log("PASS: unsupported Companion firmware returned UnsupportedCmd.");
        }
    } else {
        const contacts = await connection.getContacts();
        const targetContact = contacts.find((contact) => BufferUtils.areBuffersEqual(contact.publicKey, repeaterPublicKey));
        if(targetContact) {
            if(targetContact.outPathLen !== 0) {
                throw new Error("The repeater exists in the contact table but does not have a direct route. Refusing to modify its route.");
            }
        } else {
            await connection.addOrUpdateContact(
                repeaterPublicKey,
                Constants.AdvType.Repeater,
                0,
                0,
                new Uint8Array(64),
                "RegionTest",
                Math.floor(Date.now() / 1000),
                0,
                0,
            );
            addedTemporaryContact = true;
        }

        const result = await connection.getRegions(repeaterPublicKey);
        if(!Number.isInteger(result.repeaterClock) || result.repeaterClock <= 0) {
            throw new Error("Expected a positive repeater clock.");
        }
        if(!expectedRegions.every(region => result.regions.includes(region))) {
            throw new Error(`Expected regions ${JSON.stringify(expectedRegions)}; got ${JSON.stringify(result.regions)}.`);
        }
        console.log("PASS: supported Companion returned regions:", JSON.stringify(result));
    }
} finally {
    if(connected && addedTemporaryContact) {
        await connection.removeContact(repeaterPublicKey);
        const remainingContacts = await connection.getContacts();
        if(remainingContacts.some((contact) => BufferUtils.areBuffersEqual(contact.publicKey, repeaterPublicKey))) {
            throw new Error("Temporary repeater contact remained after cleanup.");
        }
        console.log("Temporary direct contact removed and verified.");
    }
    if(connected) {
        await connection.close();
    }
}
