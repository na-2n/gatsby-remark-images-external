import {
    DEFAULT_OPTIONS,
    imageClass,
    imageBackgroundClass,
    imageWrapperClass,
} from "./constants";
import visitWithParents from "unist-util-visit-parents";
import getDefinitions from "mdast-util-definitions";
import path from "path";
import queryString from "query-string";
import isRelativeUrl from "is-relative-url";
import isUrl from "is-url-superb";
import _ from "lodash";
import { fluid, stats, traceSVG } from "gatsby-plugin-sharp";
import Promise from "bluebird";
import cheerio from "cheerio";
import { slash } from "gatsby-core-utils";
import chalk from "chalk";
import { Potrace } from "potrace";
import { createRemoteFileNode } from "gatsby-source-filesystem";

// If the image is relative (not hosted elsewhere)
// 1. Find the image file
// 2. Find the image's size
// 3. Filter out any responsive image fluid sizes that are greater than the image's width
// 4. Create the responsive images.
// 5. Set the html w/ aspect ratio helper.
export default ({
    files,
    markdownNode,
    markdownAST,
    pathPrefix,
    getNode,
    reporter,
    cache,
    compiler,
    store,
    actions,
    createNodeId,
}, pluginOptions) => {
    const options = _.defaults({}, pluginOptions, { pathPrefix }, DEFAULT_OPTIONS);
    const { createNode } = actions;

    const findParentLinks = ({ children }) =>
        children.some(
            node => (node.type === "html" && !!node.value.match(/<a /)) || node.type === "link"
        );

    // Get all the available definitions in the markdown tree
    const definitions = getDefinitions(markdownAST);

    // This will allow the use of html image tags
    // const rawHtmlNodes = select(markdownAST, `html`)
    let rawHtmlNodes = [];

    visitWithParents(markdownAST, ["html", "jsx"], (node, ancestors) => {
        const inLink = ancestors.some(findParentLinks);

        rawHtmlNodes.push({ node, inLink });
    });

    // This will only work for markdown syntax image tags
    let markdownImageNodes = [];

    visitWithParents(
        markdownAST,
        ["image", "imageReference"],
        (node, ancestors) => {
            const inLink = ancestors.some(findParentLinks);

            markdownImageNodes.push({ node, inLink });
        }
    );

    const getImageInfo = uri => {
        const { url, query } = queryString.parseUrl(uri);
        return {
            ext: path.extname(url).split(".").pop(),
            url,
            query,
        };
    };

    const getImageCaption = async (node, overWrites) => {
        const getCaptionString = () => {
            const captionOptions = Array.isArray(options.showCaptions)
                ? options.showCaptions
                : options.showCaptions === true
                    ? ["title", "alt"]
                    : false;

            if (captionOptions) {
                for (const option of captionOptions) {
                    switch (option) {
                        case "title":
                            if (node.title) {
                                return node.title;
                            }

                            break;

                        case "alt":
                            if (overWrites.alt) {
                                return overWrites.alt;
                            }

                            if (node.alt) {
                                return node.alt;
                            }

                            break;
                    }
                }
            }

            return "";
        };

        const captionString = getCaptionString();

        if (!options.markdownCaptions || !compiler) {
            return _.escape(captionString);
        }

        return compiler.generateHTML(await compiler.parseString(captionString));
    };

    // Takes a node and generates the needed images and then returns
    // the needed HTML replacement for the image
    const generateImagesAndUpdateNode = async function (
        node,
        resolve,
        inLink,
        overWrites = {}
    ) {
    // Check if this markdownNode has a File parent. This plugin
    // won't work if the image isn't hosted locally.
        const parentNode = getNode(markdownNode.parent);

        const { url } = getImageInfo(node.url);

        let imageNode;


        if (!isUrl(url)) {
            let imagePath;

            if (parentNode && parentNode.dir) {
                imagePath = slash(path.join(parentNode.dir, url));
            } else {
                return null;
            }

            imageNode = _.find(files, file => {
                if (file && file.absolutePath) {
                    return file.absolutePath === imagePath;
                }
                return null;
            });
        } else {
            imageNode = await createRemoteFileNode({
                url,
                parentNodeId: parentNode.id,
                createNode,
                createNodeId,
                cache,
                store,
            });
        }

        if (!imageNode) {
            return resolve();
        }

        let fluidResult = await fluid({
            file: imageNode,
            args: options,
            reporter,
            cache,
        });

        if (!fluidResult) {
            return resolve();
        }

        const originalImg = fluidResult.originalImg;
        const fallbackSrc = fluidResult.src;
        const srcSet = fluidResult.srcSet;
        const presentationWidth = fluidResult.presentationWidth;

        // Generate default alt tag
        const srcSplit = getImageInfo(node.url).url.split("/");
        const fileName = srcSplit[srcSplit.length - 1];
        const fileNameNoExt = fileName.replace(/\.[^/.]+$/, "");
        const defaultAlt = fileNameNoExt.replace(/[^A-Z0-9]/gi, " ");

        const alt = _.escape(
            overWrites.alt ? overWrites.alt : node.alt ? node.alt : defaultAlt
        );

        const title = node.title ? _.escape(node.title) : alt;

        const loading = options.loading;

        if (!["lazy", "eager", "auto"].includes(loading)) {
            reporter.warn(
                reporter.stripIndent(`
                    ${chalk.bold(loading)} is an invalid value for the ${chalk.bold("loading")} option. Please pass one of "lazy", "eager" or "auto".
                `)
            );
        }

        const imageStyle = `
            width: 100%;
            height: 100%;
            margin: 0;
            vertical-align: middle;
            position: absolute;
            top: 0;
            left: 0;
        `.replace(/\s*(\S+:)\s*/g, "$1");

        // Create our base image tag
        let imageTag = `
            <img
                class="${imageClass}"
                alt="${alt}"
                title="${title}"
                src="${fallbackSrc}"
                srcset="${srcSet}"
                sizes="${fluidResult.sizes}"
                style="${imageStyle}"
                loading="${loading}"
            />
        `.trim();

        // if options.withWebp is enabled, generate a webp version and change the image tag to a picture tag
        if (options.withWebp) {
            const webpFluidResult = await fluid({
                file: imageNode,
                args: _.defaults(
                    { toFormat: "WEBP" },
                    // override options if it's an object, otherwise just pass through defaults
                    options.withWebp === true ? {} : options.withWebp,
                    pluginOptions,
                    DEFAULT_OPTIONS
                ),
                reporter,
            });

            if (!webpFluidResult) {
                return resolve();
            }

            imageTag = `
                <picture>
                    <source
                        srcset="${webpFluidResult.srcSet}"
                        sizes="${webpFluidResult.sizes}"
                        type="${webpFluidResult.srcSetType}"
                    />
                    <source
                        srcset="${srcSet}"
                        sizes="${fluidResult.sizes}"
                        type="${fluidResult.srcSetType}"
                    />
                    <img
                        class="${imageClass}"
                        src="${fallbackSrc}"
                        alt="${alt}"
                        title="${title}"
                        loading="${loading}"
                        style="${imageStyle}"
                    />
                </picture>
            `.trim();
        }

        let placeholderImageData = fluidResult.base64;

        // if options.tracedSVG is enabled generate the traced SVG and use that as the placeholder image
        if (options.tracedSVG) {
            let args = typeof options.tracedSVG === "object" ? options.tracedSVG : {};

            // Translate Potrace constants (e.g. TURNPOLICY_LEFT, COLOR_AUTO) to the values Potrace expects
            const argsKeys = Object.keys(args);

            args = argsKeys.reduce((result, key) => {
                const value = args[key];
                result[key] = Potrace.hasOwnProperty(value) ? Potrace[value] : value;
                return result;
            }, {});

            const tracedSVG = await traceSVG({
                file: imageNode,
                args,
                fileArgs: args,
                cache,
                reporter,
            });

            // Escape single quotes so the SVG data can be used in inline style attribute with single quotes
            placeholderImageData = tracedSVG.replace(/'/g, "\\'");
        }

        const ratio = `${(1 / fluidResult.aspectRatio) * 100}%`;

        const wrapperStyle = typeof options.wrapperStyle === "function"
            ? options.wrapperStyle(fluidResult)
            : options.wrapperStyle;

        // Construct new image node w/ aspect ratio placeholder
        const imageCaption = options.showCaptions
            && (await getImageCaption(node, overWrites));

        let removeBgImage = false;

        if (options.disableBgImageOnAlpha) {
            const imageStats = await stats({ file: imageNode, reporter });
            if (imageStats && imageStats.isTransparent) removeBgImage = true;
        }

        if (options.disableBgImage) {
            removeBgImage = true;
        }

        const bgImage = removeBgImage
            ? ""
            : `background-image: url('${placeholderImageData}'); background-size: cover;`;

        let rawHTML = `
            <span
                class="${imageBackgroundClass}"
                style="padding-bottom: ${ratio}; position: relative; bottom: 0; left: 0;${bgImage} display: block;"
            >
            </span>
            ${imageTag}
        `.trim();

        // Make linking to original image optional.
        if (!inLink && options.linkImagesToOriginal) {
            rawHTML = `
                <a
                    class="gatsby-resp-image-link"
                    href="${originalImg}"
                    style="display: block"
                    target="_blank"
                    rel="noopener"
                >
                    ${rawHTML}
                </a>
            `.trim();
        }

        rawHTML = `
            <span
                class="${imageWrapperClass}"
                style="position: relative; display: block; margin-left: auto; margin-right: auto; max-width: ${presentationWidth}px; ${imageCaption ? "" : wrapperStyle}"
            >
                ${rawHTML}
            </span>
        `.trim();

        // Wrap in figure and use title as caption
        if (imageCaption) {
            rawHTML = `
                <figure class="gatsby-resp-image-figure" style="${wrapperStyle}">
                    ${rawHTML}
                    <figcaption class="gatsby-resp-image-figcaption">${imageCaption}</figcaption>
                </figure>
            `.trim();
        }

        return rawHTML;
    };

    return Promise.all(
    // Simple because there is no nesting in markdown
        markdownImageNodes.map(
            ({ node, inLink }) =>
                new Promise(async resolve => {
                    const overWrites = {};
                    let refNode;

                    if (!node.hasOwnProperty("url")
                        && node.hasOwnProperty("identifier")) {
                        //consider as imageReference node
                        refNode = node;
                        node = definitions(refNode.identifier);
                        // pass original alt from referencing node
                        overWrites.alt = refNode.alt;

                        if (!node) {
                            // no definition found for image reference,
                            // so there's nothing for us to do.
                            return resolve();
                        }
                    }
                    const fileType = getImageInfo(node.url).ext;

                    // Ignore gifs as we can't process them,
                    // svgs as they are already responsive by definition
                    if ((isRelativeUrl(node.url) || isUrl(node.url))
                        && fileType !== "gif"
                        && fileType !== "svg") {
                        const rawHTML = await generateImagesAndUpdateNode(
                            node,
                            resolve,
                            inLink,
                            overWrites
                        );

                        if (rawHTML) {
                            // Replace the image or ref node with an inline HTML node.
                            if (refNode) {
                                node = refNode;
                            }
                            node.type = "html";
                            node.value = rawHTML;
                        }
                        return resolve(node);
                    } else {
                        // Image isn't relative so there's nothing for us to do.
                        return resolve();
                    }
                })
        )
    ).then(markdownImageNodes =>
        // HTML image node stuff
        Promise.all(
            // Complex because HTML nodes can contain multiple images
            rawHtmlNodes.map(
                ({ node, inLink }) =>
                    new Promise(async resolve => {
                        if (!node.value) {
                            return resolve();
                        }

                        const $ = cheerio.load(node.value);

                        if ($("img").length === 0) {
                            // No img tags
                            return resolve();
                        }

                        let imageRefs = [];

                        $("img").each(function () {
                            imageRefs.push($(this));
                        });

                        for (let thisImg of imageRefs) {
                            // Get the details we need.
                            let formattedImgTag = {
                                url: thisImg.attr("src"),
                                title: thisImg.attr("title"),
                                alt: thisImg.attr("alt")
                            };

                            if (!formattedImgTag.url) {
                                return resolve();
                            }

                            const fileType = getImageInfo(formattedImgTag.url).ext;

                            // Ignore gifs as we can't process them,
                            // svgs as they are already responsive by definition
                            if ((isRelativeUrl(formattedImgTag.url) || isUrl(formattedImgTag.url))
                                && fileType !== "gif"
                                && fileType !== "svg") {
                                const rawHTML = await generateImagesAndUpdateNode(
                                    formattedImgTag,
                                    resolve,
                                    inLink
                                );

                                if (rawHTML) {
                                    // Replace the image string
                                    thisImg.replaceWith(rawHTML);
                                } else {
                                    return resolve();
                                }
                            }
                        }

                        // Replace the image node with an inline HTML node.
                        node.type = "html";
                        node.value = $("body").html(); // fix for cheerio v1

                        return resolve(node);
                    })
            )
        ).then(htmlImageNodes =>
            markdownImageNodes.concat(htmlImageNodes).filter(node => !!node)
        )
    );
};