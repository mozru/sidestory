// dma_ctrl: the control FSM. It moves no data itself: it decides when a read burst may be
// issued, when enough data has arrived to issue a write burst, and when the transfer is done,
// and drives one-cycle strobes into the datapath blocks.
//
//   IDLE -> LOAD -> READ_BURST -> WAIT_DATA -> WRITE_BURST -> READ_BURST ... -> DONE
//
// A write burst runs in the background while the next read is issued; the FSM waits in
// WAIT_WRITE only when it needs the write port and it's still busy. On an error the FSM sits
// in ERROR, with drain emptying the datapath, until both ports are idle.
module dma_ctrl #(
  parameter int BW  = 18,  // beat-count width
  parameter int BLW = 5    // burst-length width
) (
  input  logic           clk,
  input  logic           rst_n,
  // from / to the CSRs
  input  logic           start,
  input  logic           len_zero,
  input  logic [2:0]     src_off,
  input  logic [2:0]     dst_off,
  output logic           busy,
  output logic           drain,          // ERROR: drain the FIFO, finish bursts with empty strobes
  output logic           done_set,
  output logic           err_set,
  output logic [1:0]     err_code,
  // datapath enable: latch the configuration
  output logic           load,
  // read side
  input  logic           rd_has_burst,
  output logic           rd_start,      // also acknowledges the read address generator
  input  logic           rd_busy,
  input  logic           rd_done,
  input  logic           rd_err,
  input  logic           fifo_push,     // a read beat entered the FIFO
  input  logic           fifo_almost_full,
  // write side
  input  logic           wr_has_burst,
  input  logic [BLW-1:0] wr_burst_len,
  output logic           wr_start,      // also acknowledges the write address generator
  input  logic           wr_busy,
  input  logic           wr_done,
  input  logic           wr_err
);

  typedef enum logic [2:0] {
    IDLE, LOAD, READ_BURST, WAIT_DATA, WRITE_BURST, WAIT_WRITE, DONE, ERROR
  } state_e;

  state_e        state_q, state_d;
  logic [BW-1:0] in_rcvd_q;     // read beats that reached the FIFO
  logic [BW-1:0] out_issued_q;  // write beats already promised to write bursts
  logic          extra_q;       // the packer swallows one extra beat (dst_off < src_off)
  logic [1:0]    err_code_q, err_code_d;
  logic          credit_ok;

  // A write burst may start once the packer is sure to have its data: every read is in,
  // or enough beats arrived to cover what's promised plus this burst.
  assign credit_ok = !rd_has_burst ||
                     (in_rcvd_q >= out_issued_q + BW'(wr_burst_len) + BW'(extra_q));

  always_comb begin
    state_d    = state_q;
    err_code_d = err_code_q;
    load       = 1'b0;
    rd_start   = 1'b0;
    wr_start   = 1'b0;
    done_set   = 1'b0;
    err_set    = 1'b0;
    drain      = 1'b0;
    unique case (state_q)
      IDLE: if (start) state_d = LOAD;
      LOAD: begin
        load = 1'b1;
        if (len_zero) begin
          err_code_d = 2'd1;
          state_d    = ERROR;
        end else begin
          state_d = READ_BURST;
        end
      end
      READ_BURST: begin
        if (!rd_has_burst || fifo_almost_full) begin
          state_d = WRITE_BURST;  // nothing to read, or no room: go write
        end else begin
          rd_start = 1'b1;
          state_d  = WAIT_DATA;
        end
      end
      WAIT_DATA: begin
        if (rd_done) begin
          if (rd_err) begin
            err_code_d = 2'd2;
            state_d    = ERROR;
          end else begin
            state_d = credit_ok ? WRITE_BURST : READ_BURST;
          end
        end
      end
      WRITE_BURST: begin
        if (!wr_has_burst) begin
          state_d = wr_busy ? WAIT_WRITE : DONE;   // let the last write finish
        end else if (wr_busy) begin
          state_d = WAIT_WRITE;                    // the port still has the previous burst
        end else if (credit_ok) begin
          wr_start = 1'b1;
          state_d  = READ_BURST;                   // the write runs while we read on
        end else begin
          state_d = READ_BURST;
        end
      end
      WAIT_WRITE: begin
        if (wr_done) state_d = READ_BURST;
      end
      DONE: begin
        done_set = 1'b1;
        state_d  = IDLE;
      end
      ERROR: begin
        drain = 1'b1;
        if (!rd_busy && !wr_busy) begin
          err_set = 1'b1;
          state_d = IDLE;
        end
      end
      default: state_d = IDLE;
    endcase
    // Writes overlap reads, so a failed write response can arrive in any busy state: abort.
    if (wr_done && wr_err && state_q != IDLE && state_q != ERROR) begin
      rd_start   = 1'b0;
      wr_start   = 1'b0;
      err_code_d = 2'd3;
      state_d    = ERROR;
    end
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_q      <= IDLE;
      in_rcvd_q    <= '0;
      out_issued_q <= '0;
      extra_q      <= 1'b0;
      err_code_q   <= 2'd0;
    end else begin
      state_q    <= state_d;
      err_code_q <= err_code_d;
      if (load) begin
        in_rcvd_q    <= '0;
        out_issued_q <= '0;
        extra_q      <= dst_off < src_off;
      end else begin
        if (fifo_push) in_rcvd_q    <= in_rcvd_q + 1'b1;
        if (wr_start)  out_issued_q <= out_issued_q + BW'(wr_burst_len);
      end
    end
  end

  assign busy     = state_q != IDLE;
  assign err_code = err_code_q;

endmodule
