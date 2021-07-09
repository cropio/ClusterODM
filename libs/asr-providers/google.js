/**
 *  ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM
 *  Copyright (C) 2018-present MasseranoLabs LLC
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
const AbstractASRProvider = require('../classes/AbstractASRProvider');
const utils = require('../utils');
const S3 = require('../S3');
const short = require('short-uuid');
const logger = require('../logger');
const netutils = require("../netutils");
const fs = require('fs');


module.exports = class GoogleAsrProvider extends AbstractASRProvider {
    constructor(userConfig) {
        super({
            "project": "CHANGEME!",
            "zone": "CHANGEME!",
            "gcs": {
                "endpoint": "CHANGEME!",
                "bucket": "CHANGEME!",
                "accessID": "CHANGEME!",
                "secretKey": "CHANGEME!"
            },
            "machineImage": "ubuntu-os-cloud/global/images/ubuntu-2010-groovy-v20210325",
            "maxRuntime": -1,
            "maxUploadTime": -1,
            "instanceLimit": -1,
            "createRetries": 1,
            "tags": ["clusterodm"],
            "imageSizeMapping": [
                {"maxImages": 5, "machineType": "n1-standard-1", "preemptible": true, "storage": 10},
                {"maxImages": 50, "machineType": "n2-standard-2", "preemptible": true, "storage": 100}
            ],
            "dockerImage": "opendronemap/nodeodm"
        }, userConfig);
    }

    getDriverName() {
        return "google";
    }

    getImagePropertiesFor(imagesCount) {
        const im = this.getConfig("imageSizeMapping");

        let props = null;
        for (const k in im) {
            const mapping = im[k];
            if (mapping['maxImages'] >= imagesCount) {
                props = mapping;
                break;
            }
        }

        return props;
    }

    async getCreateArgs(imagesCount) {
        const image_props = this.getImagePropertiesFor(imagesCount);
        const args = [
            "--google-project", this.getConfig("project"),
            "--google-zone", this.getConfig("zone"),
            "--google-machine-type", image_props["machineType"],
            "--google-machine-image", this.getConfig("machineImage"),
            "--google-disk-size", image_props["storage"],
        ];

        if (utils.get(image_props, "preemptible", false)) {
            args.push("--google-preemptible");
        }

        if (this.getConfig("tags", []).length > 0) {
            args.push("--google-tags");
            args.push(this.getConfig("tags").join(","));
        }

        return args;
    }

    getMaxRuntime() {
        return this.getConfig("maxRuntime");
    }

    getMaxUploadTime() {
        return this.getConfig("maxUploadTime");
    }


    getMachinesLimit() {
        return this.getConfig("instanceLimit", -1);
    }

    getCreateRetries() {
        return this.getConfig("createRetries", 1);
    }

    getDownloadsBaseUrl() {
        return `https://${this.getConfig("gcs.bucket")}.${this.getConfig("gcs.endpoint")}`;
    }

    canHandle(imagesCount) {
        return this.getImagePropertiesFor(imagesCount) !== null;
    }

    async initialize(){
        this.validateConfigKeys([
            "project", "zone", "gcs.endpoint", "gcs.bucket", "gcs.endpoint", "gcs.accessID", "gcs.secretKey"]);

        // Test GCS
        const { accessID, secretKey, endpoint, bucket } = this.getConfig("gcs");
        await S3.testBucket(accessID, secretKey, endpoint, bucket);

        const im = this.getConfig("imageSizeMapping", []);
        if (!Array.isArray(im)) throw new Error("Invalid config key imageSizeMapping (array expected)");

        // Sort by ascending maxImages
        im.sort((a, b) => {
            if (a['maxImages'] < b['maxImages']) return -1;
            else if (a['maxImages'] > b['maxImages']) return 1;
            else return 0;
        });

        // Validate key path
        const sshKeyPath = this.getConfig("sshKey.path", "");
        if (sshKeyPath){
            logger.info("Using existing SSH key");
            const exists = await new Promise((resolve) => fs.exists(this.getConfig("sshKey.path"), resolve));
            if (!exists) throw new Error("Invalid config key sshKey.path: file does not exist");
        }
    }

    generateHostname(imagesCount){
        if (imagesCount === undefined) throw new Error("Images count missing");

        return `clusterodm-${imagesCount}-${short.generate()}`.toLocaleLowerCase();
    }


    async setupMachine(req, token, dm, nodeToken) {
        // TODO will this work in google cloud?
        // Add swap proportional to the available RAM
        const swapToMemRatio = this.getConfig("addSwap");
        if (swapToMemRatio) {
            const sshOutput = await dm.ssh(`bash -c "echo \\$(awk '/MemTotal/ { printf \\\"%d\\n\\\", \\$2 }' /proc/meminfo)"`)
            const memory = parseFloat(sshOutput.trim());
            if (!isNaN(memory)) {
                await dm.ssh(`bash -c "sudo fallocate -l ${Math.ceil(memory * swapToMemRatio * 1024)} /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && free -h"`)
            } else {
                throw new Error(`Failed to allocate swap: ${sshOutput}`);
            }
        }

        const dockerImage = this.getConfig("dockerImage");
        const gcs = this.getConfig("gcs");
        const webhook = netutils.publicAddressPath("/commit", req, token);

        await dm.ssh([`sudo docker run -d -p 3000:3000 ${dockerImage} -q 1`,
            `--s3_access_key ${gcs.accessID}`,
            `--s3_secret_key ${gcs.secretKey}`,
            `--s3_endpoint ${gcs.endpoint}`,
            `--s3_bucket ${gcs.bucket}`,
            `--webhook ${webhook}`,
            `--token ${nodeToken}`].join(" "));
    }
}