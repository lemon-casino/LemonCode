cmake_minimum_required(VERSION 3.21)

cmake_policy(SET CMP0091 NEW)
project(lcode_native_ugrep LANGUAGES C CXX)

if(NOT MSVC)
  message(FATAL_ERROR "LCode Windows ugrep must be built with MSVC")
endif()

foreach(source_name UGREP PCRE2 ZLIB BZIP2 ZSTD BROTLI)
  if(NOT DEFINED LCODE_${source_name}_SOURCE_DIR)
    message(FATAL_ERROR "Missing LCODE_${source_name}_SOURCE_DIR")
  endif()
endforeach()

if(NOT DEFINED LCODE_UGREP_OUTPUT_DIR)
  message(FATAL_ERROR "Missing LCODE_UGREP_OUTPUT_DIR")
endif()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)

# 随机构建目录不能进入最终 PE，否则同版本工具无法跨 CLI 复用同一份 runtime cache。
if(DEFINED LCODE_BUILD_PATH)
  add_compile_options("/pathmap:${LCODE_BUILD_PATH}=lcode-native-search")
endif()

set(BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2_8 ON CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2_16 OFF CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2_32 OFF CACHE BOOL "" FORCE)
set(PCRE2_BUILD_PCRE2GREP OFF CACHE BOOL "" FORCE)
set(PCRE2_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(PCRE2_SHOW_REPORT OFF CACHE BOOL "" FORCE)
set(PCRE2_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
set(PCRE2_SUPPORT_JIT ON CACHE BOOL "" FORCE)
add_subdirectory("${LCODE_PCRE2_SOURCE_DIR}" pcre2 EXCLUDE_FROM_ALL)

set(SKIP_INSTALL_ALL ON CACHE BOOL "" FORCE)
add_subdirectory("${LCODE_ZLIB_SOURCE_DIR}" zlib EXCLUDE_FROM_ALL)

add_library(lcode_bzip2 STATIC
  "${LCODE_BZIP2_SOURCE_DIR}/blocksort.c"
  "${LCODE_BZIP2_SOURCE_DIR}/huffman.c"
  "${LCODE_BZIP2_SOURCE_DIR}/crctable.c"
  "${LCODE_BZIP2_SOURCE_DIR}/randtable.c"
  "${LCODE_BZIP2_SOURCE_DIR}/compress.c"
  "${LCODE_BZIP2_SOURCE_DIR}/decompress.c"
  "${LCODE_BZIP2_SOURCE_DIR}/bzlib.c"
)
target_compile_definitions(lcode_bzip2 PRIVATE _CRT_SECURE_NO_WARNINGS)
target_include_directories(lcode_bzip2 PUBLIC "${LCODE_BZIP2_SOURCE_DIR}")

set(ZSTD_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_USE_STATIC_RUNTIME ON CACHE BOOL "" FORCE)
add_subdirectory("${LCODE_ZSTD_SOURCE_DIR}/build/cmake" zstd EXCLUDE_FROM_ALL)

set(BROTLI_BUNDLED_MODE ON CACHE BOOL "" FORCE)
add_subdirectory("${LCODE_BROTLI_SOURCE_DIR}" brotli EXCLUDE_FROM_ALL)

set(LCODE_VIIZ_SOURCE_DIR "${LCODE_UGREP_SOURCE_DIR}/lzma/C")
add_library(lcode_viiz STATIC
  "${LCODE_VIIZ_SOURCE_DIR}/viizip.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zAlloc.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zArcIn.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zBuf.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zBuf2.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zCrc.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zCrcOpt.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zDec.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zFile.c"
  "${LCODE_VIIZ_SOURCE_DIR}/7zStream.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Bcj2.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Bra.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Bra86.c"
  "${LCODE_VIIZ_SOURCE_DIR}/BraIA64.c"
  "${LCODE_VIIZ_SOURCE_DIR}/CpuArch.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Delta.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Lzma2Dec.c"
  "${LCODE_VIIZ_SOURCE_DIR}/LzmaDec.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Ppmd7.c"
  "${LCODE_VIIZ_SOURCE_DIR}/Ppmd7Dec.c"
)
target_compile_definitions(lcode_viiz PRIVATE
  Z7_PPMD_SUPPORT
  Z7_EXTRACT_ONLY
  NDEBUG
  _CRT_SECURE_NO_WARNINGS
)
target_include_directories(lcode_viiz PUBLIC "${LCODE_VIIZ_SOURCE_DIR}")

set(LCODE_REFLEX_SOURCES
  "${LCODE_UGREP_SOURCE_DIR}/lib/block_scripts.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/composer.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/convert.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/debug.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/error.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/input.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/language_scripts.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/letter_case.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/letter_scripts.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/matcher.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/pattern.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/posix.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/simd.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/unicode.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/lib/utf8.cpp"
)

add_library(lcode_reflex STATIC ${LCODE_REFLEX_SOURCES})
target_compile_definitions(lcode_reflex PRIVATE WITH_NO_CODEGEN)

add_executable(ugrep
  "${LCODE_UGREP_SOURCE_DIR}/src/ugrep.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/cnf.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/glob.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/output.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/query.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/screen.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/stats.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/vkey.cpp"
  "${LCODE_UGREP_SOURCE_DIR}/src/zopen.c"
)

add_library(lcode_ugrep_contract INTERFACE)
target_compile_definitions(lcode_ugrep_contract INTERFACE
  HAVE_LIBBROTLI
  HAVE_LIBBZ2
  HAVE_LIBZ
  HAVE_LIBZSTD
  HAVE_PCRE2
  NDEBUG
  PCRE2_STATIC
  WITH_COLOR
  WITH_NO_INDENT
  _CONSOLE
  _CRT_NONSTDC_NO_WARNINGS
  _CRT_SECURE_NO_WARNINGS
)
if(CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  target_compile_definitions(lcode_ugrep_contract INTERFACE HAVE_NEON)
else()
  target_compile_definitions(lcode_ugrep_contract INTERFACE HAVE_SSE2)
endif()
target_compile_features(lcode_ugrep_contract INTERFACE cxx_std_17)
# ugrep 固定源码是无 BOM UTF-8；中文 Windows 按 CP936 解析时会触发 C4819/C1070，并改写 UTF-8 字符串字面量。
target_compile_options(lcode_ugrep_contract INTERFACE
  /utf-8
  $<$<COMPILE_LANGUAGE:CXX>:/EHsc>
)
target_include_directories(lcode_ugrep_contract INTERFACE
  "${LCODE_UGREP_SOURCE_DIR}/include"
  "${LCODE_UGREP_SOURCE_DIR}/src"
  "${LCODE_VIIZ_SOURCE_DIR}"
)

target_link_libraries(lcode_reflex PRIVATE lcode_ugrep_contract pcre2-8-static)
target_link_libraries(ugrep PRIVATE
  lcode_ugrep_contract
  lcode_reflex
  lcode_viiz
  pcre2-8-static
  zlibstatic
  lcode_bzip2
  libzstd_static
  brotlienc
  brotlidec
  brotlicommon
)
target_link_options(ugrep PRIVATE /Brepro)
set_target_properties(ugrep PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${LCODE_UGREP_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${LCODE_UGREP_OUTPUT_DIR}"
)
