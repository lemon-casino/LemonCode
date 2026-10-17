/** 同一播放时钟派生剧情位置和背景时间；欢迎不收拢，但背景不能因此停帧。 */
export class StartupSceneClock {
  elapsed = 0;
  resource = 0;
  private origin = 0;
  private offset = 0;
  private ambient = false;
  advance(now: number, duration: number) {
    const time = Math.max(0, (now - this.origin) / 1000);
    if (this.ambient) this.resource = time;
    else {
      this.elapsed = Math.min(duration, time);
      this.resource = this.elapsed + this.offset;
    }
  }
  resume(now: number) {
    this.origin = now - (this.ambient ? this.resource : this.elapsed) * 1000;
  }
  seek(seconds: number, now: number) {
    this.elapsed = this.resource = seconds;
    this.offset = 0;
    this.resume(now);
  }
  setAmbient(enabled: boolean, now: number, holdAt: number) {
    if (this.ambient === enabled) return;
    this.ambient = enabled;
    if (enabled) this.elapsed = holdAt;
    else this.offset = this.resource - this.elapsed;
    this.resume(now);
  }
}
