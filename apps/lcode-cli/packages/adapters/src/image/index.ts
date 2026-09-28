import { Jimp, ResizeStrategy } from "jimp";
import {
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
  type ImageProcessorPort,
  type ImageResizeRequest,
  type ImageResizeResult,
} from "@lcode/contracts";
import { prepareJimpImageForModel } from "./jimp-compression.js";
import { jimpOutputMediaType, throwIfAborted } from "./jimp-media.js";

export function createJimpImageProcessorAdapter(): ImageProcessorPort {
  return new JimpImageProcessorAdapter();
}

class JimpImageProcessorAdapter implements ImageProcessorPort {
  async resizeToFit(
    request: ImageResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageResizeResult> {
    throwIfAborted(options.signal);
    if (!Number.isFinite(request.maxDimension) || request.maxDimension <= 0) {
      throw new Error("Image resize maxDimension must be a positive finite number");
    }

    const input = Buffer.from(request.data);
    if (request.mediaType === "image/webp") {
      return {
        data: input,
        mediaType: request.mediaType,
        resized: false,
      };
    }

    const image = await Jimp.read(input);
    throwIfAborted(options.signal);

    const originalWidth = image.bitmap.width;
    const originalHeight = image.bitmap.height;
    if (originalWidth <= request.maxDimension && originalHeight <= request.maxDimension) {
      return {
        data: input,
        mediaType: request.mediaType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        resized: false,
      };
    }

    image.scaleToFit({
      h: request.maxDimension,
      mode: ResizeStrategy.BICUBIC,
      w: request.maxDimension,
    });
    throwIfAborted(options.signal);

    const outputMediaType = jimpOutputMediaType(request.mediaType, image.mime);
    const data = await image.getBuffer(outputMediaType);
    throwIfAborted(options.signal);

    return {
      data,
      mediaType: outputMediaType,
      originalWidth,
      originalHeight,
      width: image.bitmap.width,
      height: image.bitmap.height,
      resized: true,
    };
  }

  prepareForModel(
    request: ImagePrepareForModelRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImagePrepareForModelResult> {
    return prepareJimpImageForModel(request, options);
  }
}
