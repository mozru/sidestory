// dma_csr: the software-visible registers of the DMA engine.
//
//   0x00 CTRL    [0] start (write 1, self-clearing)   [1] irq_en
//   0x04 STATUS  [0] busy (RO)   [1] done (W1C)   [2] error (W1C)
//   0x08 SRC     source byte address (any alignment)
//   0x0C DST     destination byte address (any alignment)
//   0x10 LEN     transfer length in bytes
//   0x14 ERR     [1:0] error code: 1 zero length, 2 read error, 3 write error
//
// SRC, DST and LEN are ignored while the engine is busy, so a transfer's configuration
// can't change under it.
module dma_csr #(
  parameter int AW = 32,
  parameter int LW = 20
) (
  input  logic          clk,
  input  logic          rst_n,
  // register bus (word addressed)
  input  logic          csr_we,
  input  logic [4:2]    csr_addr,
  input  logic [31:0]   csr_wdata,
  output logic [31:0]   csr_rdata,
  // configuration to the engine
  output logic          start,
  output logic [AW-1:0] src_base,
  output logic [AW-1:0] dst_base,
  output logic [LW-1:0] len,
  // status from the engine
  input  logic          busy,
  input  logic          done_set,
  input  logic          err_set,
  input  logic [1:0]    err_code,
  output logic          irq
);

  localparam logic [2:0] A_CTRL = 3'd0, A_STATUS = 3'd1, A_SRC = 3'd2,
                         A_DST  = 3'd3, A_LEN    = 3'd4, A_ERR = 3'd5;

  logic          irq_en_q;
  logic          done_q, err_q;
  logic [1:0]    err_code_q;
  logic [AW-1:0] src_q, dst_q;
  logic [LW-1:0] len_q;

  // A write of CTRL.start while idle launches a transfer (one-cycle pulse).
  assign start = csr_we && (csr_addr == A_CTRL) && csr_wdata[0] && !busy;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      irq_en_q   <= 1'b0;
      done_q     <= 1'b0;
      err_q      <= 1'b0;
      err_code_q <= 2'd0;
      src_q      <= '0;
      dst_q      <= '0;
      len_q      <= '0;
    end else begin
      if (csr_we) begin
        unique case (csr_addr)
          A_CTRL:   irq_en_q <= csr_wdata[1];
          A_STATUS: begin  // write 1 to clear
            if (csr_wdata[1]) done_q <= 1'b0;
            if (csr_wdata[2]) err_q  <= 1'b0;
          end
          A_SRC:    if (!busy) src_q <= csr_wdata[AW-1:0];
          A_DST:    if (!busy) dst_q <= csr_wdata[AW-1:0];
          A_LEN:    if (!busy) len_q <= csr_wdata[LW-1:0];
          default:  ;
        endcase
      end
      // A new transfer clears the old outcome; the engine's strobes set the new one.
      if (start) begin
        done_q <= 1'b0;
        err_q  <= 1'b0;
      end
      if (done_set) done_q <= 1'b1;
      if (err_set) begin
        err_q      <= 1'b1;
        err_code_q <= err_code;
      end
    end
  end

  // Read mux.
  always_comb begin
    csr_rdata = '0;
    unique case (csr_addr)
      A_CTRL:   csr_rdata[1]      = irq_en_q;
      A_STATUS: csr_rdata[2:0]    = {err_q, done_q, busy};
      A_SRC:    csr_rdata[AW-1:0] = src_q;
      A_DST:    csr_rdata[AW-1:0] = dst_q;
      A_LEN:    csr_rdata[LW-1:0] = len_q;
      A_ERR:    csr_rdata[1:0]    = err_code_q;
      default:  ;
    endcase
  end

  assign src_base = src_q;
  assign dst_base = dst_q;
  assign len      = len_q;
  assign irq      = irq_en_q && (done_q || err_q);

endmodule
