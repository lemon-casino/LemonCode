/// <reference types="node" />
/**
 * 把 width*height*3 的 RGB 像素编码为 PNG（colortype 2 / 8bit / filter 0）。
 * 内部模块：不进 package.json exports，包外不可 import。
 */
export declare function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer;
