/*
Copyright 2017 - 2019 matrix-appservice-discord

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Cli, Bridge, AppServiceRegistration, ClientFactory } from "matrix-appservice-bridge";
import * as Bluebird from "bluebird";
import * as yaml from "js-yaml";
import * as fs from "fs";
import { DiscordBridgeConfig } from "./config";
import { DiscordBot } from "./bot";
import { MatrixRoomHandler } from "./matrixroomhandler";
import { DiscordStore } from "./store";
import { Provisioner } from "./provisioner";
import { Log } from "./log";
import "source-map-support/register";

const log = new Log("DiscordAS");

const cli = new Cli({
    bridgeConfig: {
        affectsRegistration: true,
        schema: "./config/config.schema.yaml",
    },
    generateRegistration,
    registrationPath: "discord-registration.yaml",
    run,
});

try {
    cli.run();
} catch (err) {
    log.error("Failed to start bridge.");
    log.error(err);
}

function generateRegistration(reg, callback)  {
    reg.setId(AppServiceRegistration.generateToken());
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("_discord_bot");
    reg.addRegexPattern("users", "@_discord_.*", true);
    reg.addRegexPattern("aliases", "#_discord_.*", true);
    reg.setRateLimited(false);
    reg.setProtocols(["discord"]);
    callback(reg);
}

interface ICallbackFn {
    (...args: any[]): Promise<any>;
}

async function run(port: number, fileConfig: DiscordBridgeConfig) {
    const config = new DiscordBridgeConfig();
    config.ApplyConfig(fileConfig);
    Log.Configure(config.logging);
    log.info("Starting Discord AS");
    const yamlConfig = yaml.safeLoad(fs.readFileSync(cli.opts.registrationPath, "utf8"));
    const registration = AppServiceRegistration.fromObject(yamlConfig);
    if (registration === null) {
        throw new Error("Failed to parse registration file");
    }

    const botUserId = `@${registration.sender_localpart}:${config.bridge.domain}`;
    const clientFactory = new ClientFactory({
        appServiceUserId: botUserId,
        token: registration.as_token,
        url: config.bridge.homeserverUrl,
    });

    const callbacks: {[id: string]: ICallbackFn;} = {};

    const bridge = new Bridge({
        clientFactory,
        controller: {
            // onUserQuery: userQuery,
            onAliasQueried: async (alias: string, roomId: string) => {
                try {
                    return await callbacks["onAliasQueried"](alias, roomId)
                } catch (err) { log.error("Exception thrown while handling \"onAliasQueried\" event", err); }
            },
            onAliasQuery: async (alias: string, aliasLocalpart: string) => {
                try {
                    return await callbacks["onAliasQuery"](alias, aliasLocalpart);
                } catch (err) { log.error("Exception thrown while handling \"onAliasQuery\" event", err); }
            },
            onEvent: async (request, context) => {
                try {
                    await request.outcomeFrom(Bluebird.resolve(callbacks["onEvent"](request, context)));
                } catch (err) {
                    log.error("Exception thrown while handling \"onEvent\" event", err);
                }
            },
            onLog: (line, isError) => {
                log.verbose("matrix-appservice-bridge", line);
            },
            thirdPartyLookup: async () => {
                try {
                    return await callbacks["thirdPartyLookup"]();
                } catch (err) {
                    log.error("Exception thrown while handling \"thirdPartyLookup\" event", err);
                }
            },
        },
        domain: config.bridge.domain,
        homeserverUrl: config.bridge.homeserverUrl,
        intentOptions: {
            clients: {
                dontJoin: true, // handled manually
            },
        },
        queue: {
            perRequest: true,
            type: "per_room",
        },
        registration,
        roomStore: config.database.roomStorePath,
        userStore: config.database.userStorePath,
        // To avoid out of order message sending.
    });
    // Warn and deprecate old config options.
    const discordbot = new DiscordBot(botUserId, config, bridge);
    const roomhandler = discordbot.RoomHandler;

    try {
        callbacks["onAliasQueried"] = roomhandler.OnAliasQueried.bind(roomhandler);
        callbacks["onAliasQuery"] = roomhandler.OnAliasQuery.bind(roomhandler);
        callbacks["onEvent"] = roomhandler.OnEvent.bind(roomhandler);
        callbacks["thirdPartyLookup"] = roomhandler.ThirdPartyLookup;
    } catch (err) {
        log.error("Failed to register callbacks. Exiting.", err);
        process.exit(1);
    }

    log.info("Initing bridge.");

    try {
        log.info("Initing store.");
        await discordbot.init();
        await bridge.run(port, config);
        log.info(`Started listening on port ${port}.`);
        log.info("Initing bot.");
        await discordbot.run();
        log.info("Discordbot started successfully.");
    } catch (err) {
        log.error(err);
        log.error("Failure during startup. Exiting.");
        process.exit(1);
    }
}
