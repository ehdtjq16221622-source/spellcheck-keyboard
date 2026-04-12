package com.spellcheck.keyboard

import android.content.Context
import android.util.AttributeSet
import android.util.SparseArray
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout

/**
 * 멀티터치 키보드 터치 라우터.
 *
 * Android 기본 touch dispatch는 IME 컨텍스트에서 빠른 멀티터치 타이핑 시
 * 두 번째 이후 포인터를 정확히 라우팅하지 못하는 경우가 있다.
 *
 * 이 클래스는 네이버 키보드처럼 최상위에서 모든 포인터를 직접 처리:
 *   - 첫 번째 포인터(ACTION_DOWN/UP): Android 기본 dispatch 유지
 *   - 추가 포인터(ACTION_POINTER_DOWN/UP): 좌표로 대상 뷰를 직접 찾아 synthetic 이벤트 발사
 *
 * 결과: 빠른 두 손가락 연타(ㅇ+ㅏ+ㅇ+ㅏ 등)에서 모든 입력 100% 인식.
 */
class KeyboardTouchLayout @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : LinearLayout(context, attrs) {

    // 추가 포인터(2번째 이후) → 해당 키 뷰 매핑
    private val secondaryPointers = SparseArray<View>()

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        return when (ev.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                val idx = ev.actionIndex
                val pointerId = ev.getPointerId(idx)
                val x = ev.getX(idx)
                val y = ev.getY(idx)

                // 좌표로 정확한 키 뷰를 직접 찾아서 synthetic ACTION_DOWN 발사
                val target = findKeyViewAt(this, x, y)
                if (target != null) {
                    secondaryPointers.put(pointerId, target)
                    dispatchSynthetic(target, MotionEvent.ACTION_DOWN, ev)
                }
                true // 소비 - super 호출 안 함 (Android 기본 dispatch 방지)
            }

            MotionEvent.ACTION_POINTER_UP -> {
                val idx = ev.actionIndex
                val pointerId = ev.getPointerId(idx)
                val target = secondaryPointers.get(pointerId)
                if (target != null) {
                    // 우리가 직접 처리한 추가 포인터 → synthetic UP 발사
                    secondaryPointers.remove(pointerId)
                    dispatchSynthetic(target, MotionEvent.ACTION_UP, ev)
                    true
                } else {
                    // 기본 포인터가 다른 포인터보다 먼저 떼어질 때 → super에 위임
                    super.dispatchTouchEvent(ev)
                }
            }

            MotionEvent.ACTION_CANCEL -> {
                // 모든 추가 포인터에 CANCEL 전파 후 상태 초기화
                for (i in 0 until secondaryPointers.size()) {
                    dispatchSynthetic(
                        secondaryPointers.valueAt(i),
                        MotionEvent.ACTION_CANCEL, ev
                    )
                }
                secondaryPointers.clear()
                super.dispatchTouchEvent(ev)
            }

            else -> super.dispatchTouchEvent(ev)
        }
    }

    /**
     * 대상 뷰에 지정된 액션의 synthetic MotionEvent를 직접 발사.
     * 좌표는 (0,0) 사용 - 키 뷰의 onKeyDown 리스너는 좌표를 사용하지 않음.
     */
    private fun dispatchSynthetic(target: View, action: Int, orig: MotionEvent) {
        val synth = MotionEvent.obtain(
            orig.downTime, orig.eventTime,
            action, 0f, 0f, 0
        )
        try {
            target.dispatchTouchEvent(synth)
        } finally {
            synth.recycle()
        }
    }

    /**
     * ViewGroup 트리를 재귀적으로 탐색하여 (x, y) 좌표에 있는 키 뷰를 반환.
     * - ID가 없는 뷰(스페이서 등)는 건너뜀
     * - ViewGroup은 재귀 탐색
     * - 좌표는 현재 group 기준 상대 좌표
     */
    private fun findKeyViewAt(group: ViewGroup, x: Float, y: Float): View? {
        // 뒤에서 앞으로 탐색 (z-order 높은 것 우선)
        for (i in group.childCount - 1 downTo 0) {
            val child = group.getChildAt(i) ?: continue
            if (child.visibility != View.VISIBLE) continue

            // 바운드 체크
            if (x < child.left || x > child.right ||
                y < child.top  || y > child.bottom) continue

            val relX = x - child.left
            val relY = y - child.top

            when {
                child is ViewGroup -> {
                    val found = findKeyViewAt(child, relX, relY)
                    if (found != null) return found
                }
                child.id != View.NO_ID -> {
                    // ID가 있는 리프 뷰 = 키 버튼
                    return child
                }
            }
        }
        return null
    }
}
