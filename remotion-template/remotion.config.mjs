import { Config } from "@remotion/cli/config";

/**
 * The public directory is pointed at the DEMO PROJECT rather than a folder inside
 * this Remotion app, so staticFile("clips/x.mp4") resolves straight to the files
 * the capture and generation steps already wrote. Nothing has to be copied or
 * symlinked, and the studio shows the current state of the project.
 *
 * render/render.mjs overrides this with --public-dir; the default here is what
 * makes `npx remotion studio` work when run from inside a scaffolded project.
 */
Config.setPublicDir("..");

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// Screen recordings are full of large flat areas; a slightly higher CRF than the
// default keeps text crisp without doubling the file size.
Config.setCrf(18);
