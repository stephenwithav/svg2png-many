'use strict';

import phantom from 'phantom';
import fs from 'fs';
import path from 'path';

/**
 * @typedef {object} Sizes
 * @prop {number} [height]
 * @prop {number} [width]
 */

/**
 * @typedef {number} ParallelPages How many pages can be opened simultaneously in PhantomJS
 */

/**
 * All matched files will be converted
 */
const SVG_REGEX = /\.svg$/i;

/**
 * Default value
 * @type {ParallelPages} 
 */
const PARALLEL_PAGES = 20;

const DEBUG = typeof v8debug === 'object' || process.env.DEBUG === 'true' || process.env.VERBOSE === 'true';


export default svg2PngDir;

/**
 * @param fileMap {object.<string, string>} key - src file path, value - dst file path
 * @param {Sizes} [size]
 * @param {ParallelPages} [pages]
 */
export function svg2PngFiles(fileMap, size = {}, pages = PARALLEL_PAGES) {
    let phantomInstance;
    const closePhantom = () => {
        if (phantomInstance) {
            log('close phantom instance');
            phantomInstance.exit();
        }
    };
    return phantom.create()
        .then(instance => {
            log('phantom instance created');
            phantomInstance = instance;
            return convertMany(instance, fileMap, size, pages);
        })
        .then(results => {
                closePhantom();
                return results;
            }, errors => {
                closePhantom();
                return Promise.reject(errors);
        });
}

/**
 * All svg files from srcDir will be converted with png into dstDir with the same name
 * @param {string} srcDir
 * @param {string} dstDir
 * @param {Sizes} [size]
 * @param {ParallelPages} [pages]
 */
export function svg2PngDir(srcDir, dstDir, size = {}, pages = PARALLEL_PAGES) {
    return new Promise((resolve, reject) => {
        fs.readdir(srcDir, (error, files) => {
            if (error) {
                return reject(error);
            }
            files = files.filter(file => SVG_REGEX.test(file));
            let fileMap = {};
            files.forEach(file => {
                let srcFile = path.join(srcDir, file);
                let dstFile = path.join(dstDir, path.parse(file).name + '.png');
                fileMap[srcFile] = dstFile;
            });
            resolve(fileMap);
        });
    }).then(fileMap => svg2PngFiles(fileMap, size, pages));
}

/**
 * @param {object} instance PhantomJS instance
 * @param {object.<string, string>} fileMap key - src file path, value - dst file path
 * @param {Sizes} size
 * @param {ParallelPages} pages
 * @returns {Promise<Array<*>,Array<*>>} resolved with list of results, rejected with list of errors
 */
function convertMany(instance, fileMap, size, pages) {
    return new Promise((resolveAll, rejectAll) => {
        const results = [];
        const errors = [];
        const poolCapacity = pages;
        var restWorkers = Object.keys(fileMap)
            .map(srcPath => () => convert(instance, srcPath, size)
                .then(buffer => saveBuffer(fileMap[srcPath], buffer)));
        log(`${restWorkers.length} files will be processed`);
        var startWorker = worker => {
            return Promise.resolve(worker()).then(result => {
                results.push(result);
            }, error => {
                errors.push(error);
            });
        };
        var processNext = () => {
            if (restWorkers.length > 0) {
                let nextWorker = restWorkers.pop();
                startWorker(nextWorker).then(processNext);
            } else if (errors.length + results.length >= Object.keys(fileMap).length) {
                if (errors.length > 0) {
                    rejectAll(errors);
                } else {
                    resolveAll(results);
                }
            }
        };
        restWorkers.splice(0, poolCapacity).forEach(worker => {
            startWorker(worker).then(processNext);
        });
    });
}

function saveBuffer(dstPath, buffer) {
    log(`${dstPath} will be saved `);
    return new Promise((resolve, reject) => {
        fs.writeFile(dstPath, buffer, 'utf8', error => {
            if (error) {
                log(`${dstPath} saved with error`);
                reject(error);
            }
            log(`${dstPath} saved successfully`);
            resolve(dstPath);
        });
    });
}

/**
 * @param {object} instance Phantom instance
 * @param {string} srcPath
 * @param {Sizes} [size]
 * @returns {Promise<Buffer>} resolved with image data
 */
function convert(instance, srcPath, size) {
    return Promise.all([instance.createPage(), fileToBase64(srcPath)])
        .then(([page, pageContent]) => {
            const closePage = () => {
                if (page) {
                    page.close()
                }
            };
            return page.open(pageContent)
                .then(status => {
                    if (status !== "success") {
                        let errMsg = `File ${srcPath} has been opened with status ${status}`;
                        logError(errMsg);
                        throw new Error(errMsg);
                    }
                    if (DEBUG) {
                        page.property('onConsoleMessage', msg => console.log(msg));
                    }
                    log(`${srcPath} opened`);
                    size = size || {};
                    log(`set ${srcPath} sizes to ${JSON.stringify(size)}`);
                    return page.evaluate(setSVGDimensions, size || {})
                        .then(checkEvalError)
                        .then(() => page.evaluate(getSVGDimensions))
                        .then(checkEvalError)
                        .then(dimensions => page.evaluate(setSVGDimensions, dimensions))
                        .then(checkEvalError)
                        .then(dimensions => page.property('viewportSize', dimensions))
                })
                .then(() => {
                    log('Render page');
                    return page.renderBase64("PNG")
                })
                .then(imageBase64 => new Buffer(imageBase64, 'base64'))
                .then(imageData => {
                    log(`${srcPath} converted successfully`);
                    closePage();
                    return imageData;
                }, error => {
                    console.log('Ooops');
                    closePage();
                    return Promise.reject(error);
                });
        });
}

/**
 * PhantomJS node brige cannot reject promises by exception,
 * it is always succeed. This extracts error from result and returns rejected promise,
 * or returns evaluate result, if no error.
 */
function checkEvalError(result) {
    if (result && result.error) {
        return Promise.reject(result.error);
    }
    return result;
}

/**
 * @param {string} filePath
 * @returns {Promise.<string>} resolved with base64 file data
 */
function fileToBase64(filePath) {
    const dataPrefix = 'data:image/svg+xml;base64,';
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (error, data) => {
            if (error) {
                return reject(error);
            }
            var base64Data = new Buffer(data).toString('base64');
            resolve(dataPrefix + base64Data);
        });
    });
}

function log() {
    DEBUG && console.log.apply(console, arguments);
}

function logError() {
    DEBUG && console.error.apply(console, arguments);
}

/**
 * Get actual sizes of root elem
 * Interpreted by PhantomJS
 * @returns {Sizes|null}
 */
function getSVGDimensions() {
    console.log('Get page sizes');
    /* global document: true */
    try {
        var el = document.documentElement;

        var widthIsPercent = /%\s*$/.test(el.getAttribute("width") || ""); // Phantom doesn't have endsWith
        var heightIsPercent = /%\s*$/.test(el.getAttribute("height") || "");
        var width = !widthIsPercent && parseFloat(el.getAttribute("width"));
        var height = !heightIsPercent && parseFloat(el.getAttribute("height"));

        if (width && height) {
            return {width: width, height: height};
        }

        var viewBoxWidth = el.viewBox.animVal.width;
        var viewBoxHeight = el.viewBox.animVal.height;

        if (width && viewBoxHeight) {
            return {width: width, height: width * viewBoxHeight / viewBoxWidth};
        }

        if (height && viewBoxWidth) {
            return {width: height * viewBoxWidth / viewBoxHeight, height: height};
        }

        return null;
    } catch (error) {
        return {error: error};
    }
}

/**
 * Set sizes to root elem
 * Interpreted by PhantomJS
 * @param {Sizes} sizes
 * @returns {Sizes} same as size param
 */
function setSVGDimensions(sizes) {
    console.log('Set page sizes', JSON.stringify(sizes));
    try {
        var height = sizes.height;
        var width = sizes.width;

        /* global document: true */
        if (!width && !height) {
            return sizes;
        }

        var el = document.documentElement;

        if (!!width) {
            el.setAttribute("width", width + "px");
        } else {
            
            el.removeAttribute("width");
        }

        if (!!height) {
            el.setAttribute("height", height + "px");
        } else {
            el.removeAttribute("height");
        }
        return sizes;
    } catch (error) {
        return {error: error};
    }
}