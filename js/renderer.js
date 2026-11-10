// WebGL2 renderer: one lit shader with shadow mapping + fog, one depth-only shadow shader.
'use strict';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aNrm;   // xyz normal, w transparency
layout(location=2) in vec4 aCol;
uniform mat4 uVP, uModel, uLightVP;
out vec3 vCol; out float vAO; out float vA; out vec3 vN; out vec4 vLP; out vec3 vW;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vec3 n = mat3(uModel) * aNrm.xyz;
  vN = n; vCol = aCol.rgb; vAO = aCol.a; vA = 1.0 - aNrm.w; vW = w.xyz;
  vLP = uLightVP * vec4(w.xyz + n * 0.07, 1.0);
  gl_Position = uVP * w;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vCol; in float vAO; in float vA; in vec3 vN; in vec4 vLP; in vec3 vW;
uniform sampler2DShadow uShadow;
uniform vec3 uSunDir, uCam, uFog;
uniform float uFogDen, uShadowOn;
out vec4 o;
float shadowF(){
  vec3 p = vLP.xyz / vLP.w * 0.5 + 0.5;
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
  vec2 t = 1.0 / vec2(textureSize(uShadow, 0));
  float s = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      s += texture(uShadow, vec3(p.xy + vec2(x, y) * t, p.z - 0.0003));
  return s / 9.0;
}
void main(){
  float nl = length(vN);
  vec3 c;
  if (nl < 0.1) {
    c = vCol * 1.5;               // emissive (muzzle flash, fire, tracers)
  } else {
    vec3 n = vN / nl;
    float ndl = max(dot(n, uSunDir), 0.0);
    float sh = (ndl > 0.0 && uShadowOn > 0.5) ? shadowF() : 1.0;
    vec3 amb = mix(vec3(0.30, 0.27, 0.24), vec3(0.50, 0.57, 0.70), n.y * 0.5 + 0.5);
    vec3 light = amb * vAO + vec3(1.0, 0.93, 0.80) * ndl * sh * 0.82 * mix(0.75, 1.0, vAO);
    c = vCol * light;
  }
  float d = length(vW - uCam);
  float f = 1.0 - exp(-pow(d * uFogDen, 2.0));
  o = vec4(mix(c, uFog, clamp(f, 0.0, 1.0)), vA);
}`;

const SVS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uLightVP, uModel;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos, 1.0); }`;

const SFS = `#version 300 es
precision mediump float;
void main(){}`;

class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;

    this.prog = this._program(VS, FS);
    this.u = {};
    for (const n of ['uVP', 'uModel', 'uLightVP', 'uShadow', 'uSunDir', 'uCam', 'uFog', 'uFogDen', 'uShadowOn'])
      this.u[n] = gl.getUniformLocation(this.prog, n);

    this.sprog = this._program(SVS, SFS);
    this.su = { uLightVP: gl.getUniformLocation(this.sprog, 'uLightVP'), uModel: gl.getUniformLocation(this.sprog, 'uModel') };

    this.shadowSize = 2048;
    this.shadowsOn = true;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  createMesh(builder, dynamic = false) {
    const gl = this.gl;
    const mesh = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: 0, dynamic };
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.BYTE, true, 20, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 20, 16);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    if (builder) this.updateMesh(mesh, builder);
    return mesh;
  }

  updateMesh(mesh, B) {
    const gl = this.gl;
    const usage = mesh.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, B.u8.subarray(0, B.vc * 20), usage);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, B.idx.subarray(0, B.ic), usage);
    mesh.count = B.ic;
  }

  deleteMesh(mesh) {
    const gl = this.gl;
    gl.deleteVertexArray(mesh.vao); gl.deleteBuffer(mesh.vbo); gl.deleteBuffer(mesh.ibo);
    mesh.count = 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  // items: [{mesh, model, shadow, blend}]  blend => alpha blended, drawn after everything opaque
  render(items, vp, camPos, lightVP, sunDir, fog, fogDen) {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    if (this.shadowsOn) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
      gl.viewport(0, 0, this.shadowSize, this.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.sprog);
      gl.uniformMatrix4fv(this.su.uLightVP, false, lightVP);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 3.0);
      for (const it of items) {
        if (!it.shadow || !it.mesh.count) continue;
        gl.uniformMatrix4fv(this.su.uModel, false, it.model);
        gl.bindVertexArray(it.mesh.vao);
        gl.drawElements(gl.TRIANGLES, it.mesh.count, gl.UNSIGNED_INT, 0);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uVP, false, vp);
    gl.uniformMatrix4fv(this.u.uLightVP, false, lightVP);
    gl.uniform3fv(this.u.uSunDir, sunDir);
    gl.uniform3fv(this.u.uCam, camPos);
    gl.uniform3fv(this.u.uFog, fog);
    gl.uniform1f(this.u.uFogDen, fogDen);
    gl.uniform1f(this.u.uShadowOn, this.shadowsOn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.u.uShadow, 0);
    const draw = (blend) => {
      for (const it of items) {
        if (!it.mesh.count || !!it.blend !== blend) continue;
        gl.uniformMatrix4fv(this.u.uModel, false, it.model);
        gl.bindVertexArray(it.mesh.vao);
        gl.drawElements(gl.TRIANGLES, it.mesh.count, gl.UNSIGNED_INT, 0);
      }
    };
    gl.disable(gl.BLEND);
    draw(false);
    // translucent pass: depth-tested against the scene but not written, canvas alpha left at 1
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    draw(true);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
